/**
 * Paid (API-key) mode and its dollar ceiling (GBRAIN-S593-LUNA-BRIDGE-API-KEY). The handler and Limits under test are the
 * real ones; only the upstream sender, the leak scan and the clock are injected. No network, no paid call.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, makeHandler, type Config } from './bridge.ts';
import { costMicro, reservationMicro } from './contract.ts';
import { BudgetStateError, Limits } from './limits.ts';
import type { Upstream } from './upstream.ts';

const SECRET = 'a'.repeat(40);
// The frozen numbers: full context window, 16k output cap, long-context 30m-write input rate and long-context output rate.
const route = { model: 'gpt-6-luna', effort: 'medium' as const, max_output_chars: 64_000, max_input_tokens: 1_050_000, max_output_tokens: 16_000, price_micro_per_mtok: { input: 250_000, output: 750_000 } };
const RES = 274_500, CAP = 10_000_000;
const ev = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const item = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const stream = (usage: unknown, tier: unknown = 'default') => ev('response.output_item.done', { item: item('{"atoms":[]}') })
  + ev('response.completed', { response: { status: 'completed', model: 'gpt-6-luna-2026-10-01', output: [], usage, service_tier: tier } });
const ok200 = (usage: unknown = { input_tokens: 817, output_tokens: 8 }, tier?: unknown): Upstream => ({ status: 200, raw: Buffer.from(stream(usage, tier)), charCapHit: false });
const state = (dir: string) => JSON.parse(readFileSync(join(dir, 'counters.json'), 'utf8'));
const rows = (dir: string) => readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const body = { model: 'gpt-6-luna', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }] };

function setup(o: Partial<{ upstream: (b: any) => Promise<Upstream>; cap: number; spend: Record<string, number> | null; counters: string | null; now: () => number; auth: 'plan' | 'api_key'; concurrency: number }> = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'budget-test-'));
  const t0 = Date.parse('2026-11-15T12:00:00Z'), now = o.now ?? (() => t0);
  if (o.counters !== null) writeFileSync(join(dir, 'counters.json'), o.counters ?? JSON.stringify({ hour_start: now(), hour: 0, day_start: now(), day: 0, ...(o.spend === null ? {} : { spend: o.spend ?? {} }) }));
  const cfg: Config = { port: 0, caller_secret_file: '', state_dir: dir, auth_dir: '/nonexistent-auth-dir', routes: { 'gpt-6-luna': route }, halt_on: ['upstream_auth'],
    ceilings: { per_hour: 1000, per_day: 10000, concurrency: o.concurrency ?? 2, usd_micro_per_day: o.cap ?? CAP }, max_body_bytes: 262_144,
    upstream: { connect_ms: 1000, request_ms: 1000, auth: o.auth ?? 'api_key', api_key_file: '/x' }, leak: {} as any };
  const calls: any[] = [];
  const limits = new Limits(join(dir, 'counters.json'), cfg.ceilings, now);
  const h = makeHandler(cfg, { callerSecret: Buffer.from(SECRET), limits, now, accessToken: async () => 'sk-test', scan: async () => ({ clean: true }),
    upstream: async (b, token) => { calls.push({ body: b, token }); return o.upstream ? o.upstream(b) : ok200(); } });
  const post = () => h(new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) }));
  return { dir, post, calls, limits, cfg };
}

test('arithmetic: the frozen reservation is 274,500 micro-dollars and every cost rounds up', () => {
  expect(reservationMicro(route)).toBe(RES);
  expect(costMicro(1, 250_000)).toBe(1);            // 0.25 micro-dollars rounds up to 1
  expect(costMicro(4, 250_000)).toBe(1); expect(costMicro(5, 250_000)).toBe(2);
  expect(costMicro(0, 250_000)).toBe(0);
  expect(costMicro(817, 250_000) + costMicro(8, 750_000)).toBe(205 + 6);
});

test('paid body is pinned: output cap, standard tier, explicit caching; the key is the bearer; a clean 200 settles down to the actual cost', async () => {
  const s = setup(); const r = await s.post();
  expect(r.status).toBe(200);
  expect(s.calls[0].body).toEqual({ model: 'gpt-6-luna', instructions: 'SYS', input: [{ role: 'user', content: 'USER' }], stream: true, store: false, reasoning: { effort: 'medium' },
    max_output_tokens: 16_000, service_tier: 'default', prompt_cache_options: { mode: 'explicit' } });
  expect(s.calls[0].token).toBe('sk-test');
  expect(state(s.dir).spend).toEqual({ '2026-11-15': 211 });
  expect(rows(s.dir)[0]).toMatchObject({ status: 200, reserved_micro: RES, spend_day: '2026-11-15', settled: true, settled_micro: 211 });
});

test('the reservation is on disk BEFORE dispatch and survives a crash before the answer', async () => {
  let seen: any;
  const s = setup({ upstream: async () => { seen = state(s.dir).spend; throw new Error('process died'); } });
  expect((await s.post()).status).toBe(502);
  expect(seen).toEqual({ '2026-11-15': RES });
  // a restarted bridge (a fresh Limits on the same file) still sees the reservation
  expect((new Limits(join(s.dir, 'counters.json'), s.cfg.ceilings) as any).readStrict().spend).toEqual({ '2026-11-15': RES });
  expect(rows(s.dir)[0]).toMatchObject({ status: 502, code: 'unknown_completion', reserved_micro: RES });
});

test('strict ceiling: 36 kept reservations fit in $10, the 37th request is refused before any upstream call', async () => {
  const s = setup({ upstream: async () => { throw new Error('unknown'); } });
  for (let i = 0; i < 36; i++) expect((await s.post()).status).toBe(502);
  expect(state(s.dir).spend['2026-11-15']).toBe(36 * RES);
  const r = await s.post();
  expect(r.status).toBe(429); expect((await r.json()).error.code).toBe('daily_budget');
  expect(Number(r.headers.get('retry-after'))).toBe(12 * 3600);
  expect(s.calls.length).toBe(36);
  expect(state(s.dir).spend['2026-11-15']).toBe(36 * RES);
  expect(existsSync(join(s.dir, 'halted.json'))).toBe(false);
});

test('two concurrent requests whose maxima together exceed what is left: exactly one is sent', async () => {
  let release!: () => void; const gate = new Promise<void>(res => { release = res; });
  const s = setup({ spend: { '2026-11-15': CAP - RES - 1 }, upstream: async () => { await gate; return ok200(); } });
  const a = s.post(), b = s.post();
  await new Promise(res => setTimeout(res, 20)); release();
  const st = [(await a).status, (await b).status].sort();
  expect(st).toEqual([200, 429]);
  expect(s.calls.length).toBe(1);
});

test('missing, corrupt or spend-less counters refuse every paid request; nothing is created or reset', async () => {
  for (const [counters, spend] of [[null, undefined], ['{not json', undefined], [undefined, null], [JSON.stringify({ hour_start: 1, hour: 0, day_start: 1, day: 0, spend: { '2026-11-15': -5 } }), undefined], [JSON.stringify({ hour_start: 1, hour: 0, day_start: 1, day: 0, spend: { today: 5 } }), undefined], [JSON.stringify({ hour_start: 1, hour: 0, day_start: 1, day: 0, spend: [] }), undefined]] as const) {
    const s = setup({ counters: counters as any, spend: spend as any });
    const before = existsSync(join(s.dir, 'counters.json')) ? readFileSync(join(s.dir, 'counters.json'), 'utf8') : null;
    const r = await s.post();
    expect(r.status).toBe(503); expect((await r.json()).error.code).toBe('budget_state_unavailable');
    expect(s.calls.length).toBe(0);
    expect(existsSync(join(s.dir, 'counters.json')) ? readFileSync(join(s.dir, 'counters.json'), 'utf8') : null).toBe(before);
  }
});

test('usage that is missing, partial, negative or fractional does not settle: the full reservation stays', async () => {
  for (const usage of [null, {}, { input_tokens: 817 }, { input_tokens: -1, output_tokens: 8 }, { input_tokens: 817.5, output_tokens: 8 }, { input_tokens: '817', output_tokens: 8 }]) {
    const s = setup({ upstream: async () => ok200(usage) });
    expect((await s.post()).status).toBe(200);
    expect(state(s.dir).spend['2026-11-15']).toBe(RES);
    expect(rows(s.dir)[0]).toMatchObject({ status: 200, settled: false, unsettled: 'usage_missing_or_malformed', reserved_micro: RES });
    expect(existsSync(join(s.dir, 'halted.json'))).toBe(false);
  }
});

test('invariant breach (usage over the maxima, or a tier that is not "default") keeps the reservation and halts all admissions', async () => {
  for (const [usage, tier, why] of [[{ input_tokens: 1_050_001, output_tokens: 8 }, 'default', 'usage_over_bound'], [{ input_tokens: 817, output_tokens: 16_001 }, 'default', 'usage_over_bound'],
    [{ input_tokens: 817, output_tokens: 8 }, 'priority', 'service_tier_not_default'], [{ input_tokens: 817, output_tokens: 8 }, undefined, 'service_tier_not_default']] as const) {
    const s = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(ev('response.output_item.done', { item: item('x') }) + ev('response.completed', { response: { status: 'completed', model: 'm', output: [], usage, ...(tier === undefined ? {} : { service_tier: tier }) } })), charCapHit: false }) });
    expect((await s.post()).status).toBe(200);
    expect(rows(s.dir)[0]).toMatchObject({ settled: false, unsettled: why });
    expect(state(s.dir).spend['2026-11-15']).toBe(RES);
    expect(JSON.parse(readFileSync(join(s.dir, 'halted.json'), 'utf8')).code).toBe('budget_invariant');
    const r = await s.post();
    expect(r.status).toBe(429); expect((await r.json()).error.code).toBe('bridge_halted');
    expect(s.calls.length).toBe(1);
  }
});

test('UTC admission day: a call admitted before midnight settles into ITS day; the next day starts from its own total', async () => {
  let t = Date.parse('2026-11-15T23:59:59Z');
  const s = setup({ now: () => t, spend: { '2026-11-14': 5_000_000 }, upstream: async () => { t = Date.parse('2026-11-16T00:00:05Z'); return ok200(); } });
  expect((await s.post()).status).toBe(200);
  expect(state(s.dir).spend).toEqual({ '2026-11-14': 5_000_000, '2026-11-15': 211 });
  expect((await s.post()).status).toBe(200);
  expect(state(s.dir).spend).toEqual({ '2026-11-14': 5_000_000, '2026-11-15': 211, '2026-11-16': 211 });
});

test('settlement is checked against the current state and can only lower a reservation', () => {
  const s = setup({ spend: { '2026-11-15': RES } });
  expect(() => s.limits.settle('2026-11-15', RES, RES + 1)).toThrow(BudgetStateError);
  expect(() => s.limits.settle('2026-11-14', RES, 1)).toThrow(BudgetStateError);   // no such day on record
  expect(() => s.limits.settle('2026-11-15', RES + 1, 1)).toThrow(BudgetStateError); // more than is recorded
  expect(state(s.dir).spend).toEqual({ '2026-11-15': RES });
  s.limits.settle('2026-11-15', RES, 211);
  expect(state(s.dir).spend).toEqual({ '2026-11-15': 211 });
});

test('a settlement that no longer fits the spend state halts instead of guessing', async () => {
  const s = setup({ upstream: async () => { writeFileSync(join(s.dir, 'counters.json'), JSON.stringify({ hour_start: 1, hour: 1, day_start: 1, day: 1, spend: {} })); return ok200(); } });
  expect((await s.post()).status).toBe(200);
  expect(rows(s.dir)[0]).toMatchObject({ settled: false, unsettled: 'spend_state_invalid' });
  expect(JSON.parse(readFileSync(join(s.dir, 'halted.json'), 'utf8')).code).toBe('budget_invariant');
});

test('a streamed quota or billing error is a 429 with its own code, no retry, reservation kept', async () => {
  for (const code of ['insufficient_quota', 'billing_hard_limit_reached']) {
    const s = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(ev('response.failed', { response: { status: 'failed', error: { code } } })), charCapHit: false }) });
    const r = await s.post();
    expect(r.status).toBe(429); expect((await r.json()).error.code).toBe(code);
    expect(s.calls.length).toBe(1);
    expect(state(s.dir).spend['2026-11-15']).toBe(RES);
  }
  const s = setup({ upstream: async () => ({ status: 429, raw: Buffer.from(JSON.stringify({ error: { code: 'insufficient_quota' } })), charCapHit: false }) });
  const r = await s.post();
  expect(r.status).toBe(429); expect((await r.json()).error.code).toBe('insufficient_quota');
  expect(state(s.dir).spend['2026-11-15']).toBe(RES);
});

test('plan mode is unchanged and never touches or needs the spend history (rollback keeps it)', async () => {
  const s = setup({ auth: 'plan', spend: { '2026-11-15': 123_456 } });
  expect((await s.post()).status).toBe(200);
  expect(s.calls[0].body).toEqual({ model: 'gpt-6-luna', instructions: 'SYS', input: [{ role: 'user', content: 'USER' }], stream: true, store: false, reasoning: { effort: 'medium' } });
  expect(state(s.dir).spend).toEqual({ '2026-11-15': 123_456 });
  expect(rows(s.dir)[0].reserved_micro).toBeUndefined();
  const fresh = setup({ auth: 'plan', counters: null });   // plan mode still starts from nothing, as before
  expect((await fresh.post()).status).toBe(200);
});

test('config validation: paid mode needs a key file path, integer prices and maxima, a positive ceiling, and a ceiling that fits concurrency x the FULL reservation', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'budget-cfg-'));
  const base = { port: 18795, caller_secret_file: '/s', state_dir: dir, auth_dir: '/a', routes: { 'gpt-6-luna': route }, ceilings: { per_hour: 600, per_day: 6000, concurrency: 2, usd_micro_per_day: CAP }, max_body_bytes: 262_144, upstream: { connect_ms: 1, request_ms: 1, auth: 'api_key', api_key_file: '/k' }, leak: {} };
  const load = (patch: (c: any) => void) => { const c = JSON.parse(JSON.stringify(base)); patch(c); const f = join(dir, `c-${Math.random()}.json`); writeFileSync(f, JSON.stringify(c)); return () => loadConfig(f); };
  expect(load(() => {})().upstream.auth).toBe('api_key');
  expect(load(c => { delete c.upstream.auth; delete c.upstream.api_key_file; delete c.ceilings.usd_micro_per_day; })().upstream.auth).toBeUndefined();   // plan config as today
  expect(load(c => { c.upstream.auth = 'oauth'; })).toThrow('CONFIG-AUTH');
  expect(load(c => { delete c.upstream.api_key_file; })).toThrow('CONFIG-API-KEY-FILE');
  expect(load(c => { c.upstream.api_key_file = 'relative'; })).toThrow('CONFIG-API-KEY-FILE');
  for (const bad of [0, -1, 1.5, '10', null, Infinity]) expect(load(c => { c.ceilings.usd_micro_per_day = bad; })).toThrow('CONFIG-BUDGET');
  for (const k of ['max_input_tokens', 'max_output_tokens']) for (const bad of [0, -1, 1.5, null]) expect(load(c => { c.routes['gpt-6-luna'][k] = bad; })).toThrow('CONFIG-ROUTE-PAID');
  for (const bad of [0, -1, 0.25, null]) expect(load(c => { c.routes['gpt-6-luna'].price_micro_per_mtok.input = bad; })).toThrow('CONFIG-ROUTE-PAID');
  expect(load(c => { delete c.routes['gpt-6-luna'].price_micro_per_mtok; })).toThrow('CONFIG-ROUTE-PAID');
  expect(load(c => { c.ceilings.usd_micro_per_day = 2 * RES - 1; })).toThrow('CONFIG-BUDGET-UNUSABLE');
  expect(load(c => { c.ceilings.usd_micro_per_day = 2 * RES; })().ceilings.usd_micro_per_day).toBe(2 * RES);
});

test('main.ts in paid mode: bad key file refuses to start without echoing it; no OAuth store is needed; a second paid writer on the same state is refused', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'budget-main-'));
  const secret = join(dir, 'caller'); writeFileSync(secret, SECRET);
  const cfgFile = (keyFile: string) => { const f = join(dir, `cfg-${Math.random()}.json`); writeFileSync(f, JSON.stringify({ port: 0, caller_secret_file: secret, state_dir: dir, auth_dir: join(dir, 'no-such-auth-dir'), routes: { 'gpt-6-luna': route }, ceilings: { per_hour: 600, per_day: 6000, concurrency: 2, usd_micro_per_day: CAP }, max_body_bytes: 262_144, upstream: { connect_ms: 1000, request_ms: 1000, auth: 'api_key', api_key_file: keyFile }, leak: {} })); return f; };
  const start = (cfg: string) => Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), cfg], { stdout: 'pipe', stderr: 'pipe' });
  const badKey = join(dir, 'bad'); writeFileSync(badKey, 'sk-short with space SECRETVALUE');
  const bad = start(cfgFile(badKey)); expect(await bad.exited).not.toBe(0);
  const errText = await new Response(bad.stderr).text();
  expect(errText).toContain('API-KEY-FILE-INVALID'); expect(errText).not.toContain('SECRETVALUE');
  const key = join(dir, 'key'); writeFileSync(key, 'sk-' + 'k'.repeat(60) + '\n');
  const a = start(cfgFile(key));
  const first = await new Promise<string>(res => { const rd = a.stdout.getReader(); rd.read().then(c => res(new TextDecoder().decode(c.value))); });
  expect(JSON.parse(first.trim().split('\n')[0])).toMatchObject({ event: 'listening', auth: 'api_key' });   // started with NO auth dir on disk
  expect(first).not.toContain('kkkk');
  expect(readFileSync(join(dir, 'paid-writer.pid'), 'utf8')).toBe(String(a.pid));
  const b = start(cfgFile(key)); expect(await b.exited).not.toBe(0);
  expect(await new Response(b.stderr).text()).toContain('PAID-WRITER-ALREADY-RUNNING');
  a.kill('SIGTERM'); await a.exited;
  expect(existsSync(join(dir, 'paid-writer.pid'))).toBe(false);
  expect(existsSync(join(dir, 'no-such-auth-dir'))).toBe(false);
}, 30_000);
