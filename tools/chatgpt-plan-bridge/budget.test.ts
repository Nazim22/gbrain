/**
 * Paid (API-key) mode and its dollar ceiling (GBRAIN-S593-LUNA-BRIDGE-API-KEY). The handler and Limits under test are the
 * real ones; only the upstream sender, the leak scan and the clock are injected. No network, no paid call.
 */
import { expect, test } from 'bun:test';
import { afterAll } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, makeHandler, MASK_NOTE, type Config } from './bridge.ts';
import { costMicro, reservationMicro } from './contract.ts';
import { BudgetStateError, Limits } from './limits.ts';
import { CustodyError, readKeyFile } from './custody.ts';
import { parseStream } from './upstream.ts';
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

function setup(o: Partial<{ upstream: (b: any) => Promise<Upstream>; cap: number; spend: Record<string, number> | null; counters: string | null; now: () => number; auth: 'plan' | 'api_key'; concurrency: number; scan: (t: string) => Promise<any>; mask: (p: string[]) => Promise<any>; body: unknown }> = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'budget-test-'));
  const t0 = Date.parse('2026-11-15T12:00:00Z'), now = o.now ?? (() => t0);
  if (o.counters !== null) writeFileSync(join(dir, 'counters.json'), o.counters ?? JSON.stringify({ hour_start: now(), hour: 0, day_start: now(), day: 0, ...(o.spend === null ? {} : { spend: o.spend ?? {} }) }));
  const cfg: Config = { port: 0, caller_secret_file: '', state_dir: dir, auth_dir: '/nonexistent-auth-dir', routes: { 'gpt-6-luna': route }, halt_on: ['upstream_auth'],
    ceilings: { per_hour: 1000, per_day: 10000, concurrency: o.concurrency ?? 2, usd_micro_per_day: o.cap ?? CAP }, max_body_bytes: 262_144,
    upstream: { connect_ms: 1000, request_ms: 1000, auth: o.auth ?? 'api_key', api_key_file: '/x' }, leak: {} as any };
  const calls: any[] = [];
  const limits = new Limits(join(dir, 'counters.json'), cfg.ceilings, now);
  const h = makeHandler(cfg, { callerSecret: Buffer.from(SECRET), limits, now, accessToken: async () => 'sk-test', scan: o.scan ?? (async () => ({ clean: true })), mask: o.mask ?? (async () => ({ unmaskable: 'test_default' })),
    upstream: async (b, token) => { calls.push({ body: b, token }); return o.upstream ? o.upstream(b) : ok200(); } });
  const post = () => h(new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(o.body ?? body) }));
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
    // untrusted spend state is an invariant breach: it latches until an operator clears it
    expect(JSON.parse(readFileSync(join(s.dir, 'halted.json'), 'utf8')).code).toBe('budget_invariant');
    const again = await s.post();
    expect(again.status).toBe(429); expect((await again.json()).error.code).toBe('bridge_halted');
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

test('strict state: negative or fractional counters and impossible dates refuse', async () => {
  const c = (o: object) => JSON.stringify({ hour_start: 1, hour: 0, day_start: 1, day: 0, spend: {}, ...o });
  for (const counters of [c({ hour: -1 }), c({ day: 0.5 }), c({ hour_start: -5 }), c({ spend: { '2026-13-40': 5 } }), c({ spend: { '2026-02-30': 5 } })]) {
    const s = setup({ counters });
    expect((await s.post()).status).toBe(503);
    expect(s.calls.length).toBe(0);
    expect(readFileSync(join(s.dir, 'counters.json'), 'utf8')).toBe(counters);
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

test('a settlement belongs to its own admission, works once, and can only lower that reservation', () => {
  const s = setup();
  const a = s.limits.admit(RES), b = s.limits.admit(RES);
  if (!a.ok || !b.ok) throw Error('admission');
  expect(state(s.dir).spend).toEqual({ '2026-11-15': 2 * RES });
  expect(() => a.settle!(RES + 1)).toThrow(BudgetStateError);     // more than the reservation: refused, and the settlement is spent
  expect(() => a.settle!(211)).toThrow(BudgetStateError);
  expect(state(s.dir).spend).toEqual({ '2026-11-15': 2 * RES });
  b.settle!(211);
  expect(state(s.dir).spend).toEqual({ '2026-11-15': RES + 211 });
  expect(() => b.settle!(211)).toThrow(BudgetStateError);         // a second settlement cannot eat the other call's reservation
  expect(state(s.dir).spend).toEqual({ '2026-11-15': RES + 211 });
  expect((s.limits.admit() as any).settle).toBeUndefined();       // plan mode has nothing to settle
});

test('a reasoning item whose opaque blob differs between the streamed item and the terminal copy does not reject the answer; a differing message still does', async () => {
  // Shape of the real stream captured 2026-11-15: output = [reasoning, message], streamed items the same except reasoning.encrypted_content.
  const reasoning = (blob: string) => ({ id: 'rs_1', type: 'reasoning', encrypted_content: blob, summary: [] });
  const msg = (text: string) => ({ id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text }] });
  const full = (streamed: object[], terminal: object[], type = 'response.completed', status = 'completed') => streamed.map(i => ev('response.output_item.done', { item: i })).join('')
    + ev(type, { response: { status, model: 'gpt-6-luna-2026-10-01', output: terminal, usage: { input_tokens: 110, output_tokens: 90 }, service_tier: 'default' } });
  const good = full([reasoning('AAAA-streamed'), msg('{"queries":["a"]}')], [reasoning('AAAA-terminal'), msg('{"queries":["a"]}')]);
  expect(parseStream(good)).toMatchObject({ kind: 'completed', outcome: { text: '{"queries":["a"]}', finish: 'stop', tier: 'default' } });
  const s = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(good), charCapHit: false }) });
  const r = await s.post();
  expect(r.status).toBe(200); expect((await r.json()).choices[0].message.content).toBe('{"queries":["a"]}');
  expect(rows(s.dir)[0]).toMatchObject({ status: 200, settled: true, settled_micro: costMicro(110, 250_000) + costMicro(90, 750_000) });
  expect(state(s.dir).spend['2026-11-15']).toBe(28 + 68);
  // the answer itself must still agree: text, order, count, and a message present in only one copy
  for (const bad of [full([reasoning('x'), msg('one')], [reasoning('x'), msg('two')]), full([msg('a'), msg('b')], [msg('b'), msg('a')]),
    full([reasoning('x'), msg('a')], [reasoning('x'), msg('a'), msg('extra')]), full([reasoning('x'), msg('a'), msg('extra')], [reasoning('x'), msg('a')])]) {
    expect(parseStream(bad).kind).toBe('unknown');
    const t = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(bad), charCapHit: false }) });
    expect((await t.post()).status).toBe(502); expect(state(t.dir).spend['2026-11-15']).toBe(RES);
  }
  // only the blob string is excused: any other reasoning difference (id, summary, count, order, blob missing or not a string) still rejects
  const r1 = reasoning('s'), m = msg('a');
  const reasoningBad: [object[], object[]][] = [
    [[r1, m], [{ ...reasoning('t'), id: 'rs_2' }, m]], [[r1, m], [{ ...reasoning('t'), summary: [{ type: 'summary_text', text: 'b' }] }, m]],
    [[r1, m], [reasoning('t'), reasoning('t'), m]], [[r1, m], [m, reasoning('t')]],
    [[r1, m], [{ id: 'rs_1', type: 'reasoning', summary: [] }, m]], [[r1, m], [{ ...reasoning('t'), encrypted_content: null }, m]],
  ];
  for (const [streamed, terminal] of reasoningBad) for (const [type, status] of [['response.completed', 'completed'], ['response.incomplete', 'incomplete']]) {
    expect(parseStream(full(streamed, terminal, type, status)).kind).toBe('unknown');
    expect(parseStream(full(terminal, streamed, type, status)).kind).toBe('unknown');
  }
  // same rule for an incomplete answer
  expect(parseStream(full([reasoning('s'), msg('part')], [reasoning('t'), msg('part')], 'response.incomplete', 'incomplete'))).toMatchObject({ kind: 'completed', outcome: { finish: 'length', text: 'part' } });
  expect(parseStream(full([reasoning('s'), msg('part')], [reasoning('t'), msg('other')], 'response.incomplete', 'incomplete')).kind).toBe('unknown');
});

test('a tier that is not "default" halts even when the usage is missing or malformed', async () => {
  for (const usage of [undefined, null, { input_tokens: 'x' }]) {
    const s = setup({ upstream: async () => ok200(usage, 'priority') });
    expect((await s.post()).status).toBe(200);
    expect(rows(s.dir)[0]).toMatchObject({ settled: false, unsettled: 'service_tier_not_default', reserved_micro: RES });
    expect(state(s.dir).spend['2026-11-15']).toBe(RES);
    expect(JSON.parse(readFileSync(join(s.dir, 'halted.json'), 'utf8')).code).toBe('budget_invariant');
  }
});

test('a halt that cannot be written to disk still stops this process: the next request is refused before upstream', async () => {
  const s = setup({ upstream: async () => ok200(undefined, 'priority') });
  symlinkSync(join(s.dir, 'nowhere', 'x'), join(s.dir, 'halted.json'));   // dangling link: reads as "no latch", cannot be created
  await expect(s.post()).rejects.toThrow();
  const r = await s.post();
  expect(r.status).toBe(429); expect((await r.json()).error.code).toBe('bridge_halted');
  expect(s.calls.length).toBe(1);
  expect(state(s.dir).spend['2026-11-15']).toBe(RES);
});

test('a stream the bridge cut itself (character bound, no terminal event) keeps the reservation and does not halt', async () => {
  const s = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(ev('response.output_text.delta', { delta: 'abc' })), charCapHit: true }) });
  const r = await s.post();
  expect(r.status).toBe(200); expect((await r.json()).choices[0].finish_reason).toBe('length');
  expect(rows(s.dir)[0]).toMatchObject({ settled: false, unsettled: 'stream_cut_before_terminal' });
  expect(state(s.dir).spend['2026-11-15']).toBe(RES);
  expect(existsSync(join(s.dir, 'halted.json'))).toBe(false);
});

test('response.incomplete is trusted only as a complete terminal envelope; anything else keeps the reservation', async () => {
  const inc = (response: object) => ev('response.output_item.done', { item: item('part') }) + ev('response.incomplete', { response });
  const good = { status: 'incomplete', model: 'm', output: [], usage: { input_tokens: 817, output_tokens: 8 }, service_tier: 'default' };
  expect(parseStream(inc(good))).toMatchObject({ kind: 'completed', outcome: { finish: 'length', text: 'part' } });
  for (const bad of [{ ...good, status: 'in_progress' }, { ...good, status: 'completed' }, { ...good, output: undefined }, { ...good, output: [item('other')] }]) {
    expect(parseStream(inc(bad)).kind).toBe('unknown');
    const s = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(inc(bad)), charCapHit: false }) });
    expect((await s.post()).status).toBe(502);
    expect(state(s.dir).spend['2026-11-15']).toBe(RES);
  }
  const s = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(inc(good)), charCapHit: false }) });
  expect((await s.post()).status).toBe(200);
  expect(state(s.dir).spend['2026-11-15']).toBe(211);
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
  // the reviewed numbers are pinned: a config may be more conservative, never less
  expect(load(c => { c.ceilings.usd_micro_per_day = CAP + 1; })).toThrow('CONFIG-BUDGET');
  expect(load(c => { c.ceilings.usd_micro_per_day = 20_000_000; })).toThrow('CONFIG-BUDGET');
  expect(load(c => { c.routes['gpt-6-luna'].model = 'some-other-model'; })).toThrow('CONFIG-ROUTE-PAID-MODEL');
  expect(load(c => { c.routes['gpt-6-luna'].price_micro_per_mtok.input = 1; })).toThrow('CONFIG-ROUTE-PAID-PIN');
  expect(load(c => { c.routes['gpt-6-luna'].price_micro_per_mtok.output = 749_999; })).toThrow('CONFIG-ROUTE-PAID-PIN');
  expect(load(c => { c.routes['gpt-6-luna'].max_input_tokens = 1; })).toThrow('CONFIG-ROUTE-PAID-PIN');
  expect(load(c => { c.routes['gpt-6-luna'].max_input_tokens = 1_049_999; })).toThrow('CONFIG-ROUTE-PAID-PIN');
  expect(load(c => { c.routes['gpt-6-luna'].max_output_tokens = 16_001; })).toThrow('CONFIG-ROUTE-PAID-PIN');
  expect(load(c => { c.routes['gpt-6-luna'].price_micro_per_mtok.input = 2_000_000_000; })).toThrow('CONFIG-ROUTE-PAID');
  for (const bad of [0, -1, 1.5, null]) expect(load(c => { c.ceilings.concurrency = bad; })).toThrow('CONFIG-CEILINGS');
  expect(load(c => { c.routes['gpt-6-luna'].max_output_tokens = 8_000; c.routes['gpt-6-luna'].price_micro_per_mtok.input = 300_000; })().routes['gpt-6-luna'].max_output_tokens).toBe(8_000);
  expect(() => costMicro(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  expect(() => costMicro(1.5, 1)).toThrow(RangeError);
  expect(load(c => { c.ceilings.usd_micro_per_day = 2 * RES; })().ceilings.usd_micro_per_day).toBe(2 * RES);
});

// Key custody needs directories nobody else can write, which the shared /tmp is not: these fixtures live beside the tests.
const SAFE = mkdtempSync(join(import.meta.dir, '.custody-test-'));
afterAll(() => rmSync(SAFE, { recursive: true, force: true }));
const UID = process.getuid!();
const GOOD_KEY = 'sk-' + 'k'.repeat(60);

test('key custody: only a regular, owner-held, at most 0640 file behind safe directories is read; every refusal is the same generic error', () => {
  const d = join(SAFE, 'k1'); mkdirSync(d, { mode: 0o755 });
  const put = (name: string, text: string, mode = 0o640) => { const f = join(d, name); writeFileSync(f, text); chmodSync(f, mode); return f; };
  const read = (f: string, o: object = {}) => readKeyFile(f, { ownerUid: UID, ...o });
  expect(read(put('ok', GOOD_KEY + '\n'))).toBe(GOOD_KEY);
  expect(read(put('ok600', GOOD_KEY, 0o600))).toBe(GOOD_KEY);
  const refused = (f: string, o: object = {}) => { let e: any; try { read(f, o); } catch (x) { e = x; } expect(e).toBeInstanceOf(CustodyError); expect(e.message).toBe('API-KEY-FILE-INVALID'); };
  refused(put('world', GOOD_KEY, 0o644));
  refused(put('groupw', GOOD_KEY, 0o660));
  refused(put('exec', GOOD_KEY, 0o740));
  refused(put('short', 'sk-short'));
  refused(put('long', 'k'.repeat(401)));
  refused(put('huge', 'k'.repeat(100_000)));
  refused(put('space', 'sk-' + 'k'.repeat(30) + ' ' + 'k'.repeat(30)));
  refused(put('ctrl', 'sk-' + 'k'.repeat(30) + '\u0007' + 'k'.repeat(30)));
  refused(put('crlf', GOOD_KEY + '\r\n'));
  refused(put('nonascii', 'sk-' + 'k'.repeat(30) + '\u00e9' + 'k'.repeat(30)));
  refused(join(d, 'missing'));
  refused(d);                                                              // a directory
  symlinkSync(join(d, 'ok'), join(d, 'link')); refused(join(d, 'link'));   // a link to a good key is still refused
  const linked = join(SAFE, 'k1-link'); symlinkSync(d, linked); refused(join(linked, 'ok'));   // a linked directory on the way
  refused(`${d}/../k1/ok`);                                               // not a normalised absolute path
  refused('relative/key');
  const open = join(SAFE, 'open'); mkdirSync(open); chmodSync(open, 0o777);
  const inOpen = join(open, 'key'); writeFileSync(inOpen, GOOD_KEY); chmodSync(inOpen, 0o640); refused(inOpen);   // an ancestor others can write
  refused(join(d, 'ok'), { ownerUid: UID + 1 });                           // not the expected owner
  refused(join(d, 'ok'), { forbiddenDir: d });                             // inside the bridge's own state
  refused(join(d, 'ok'), { forbiddenDir: SAFE });
});

// main.ts always requires a ROOT-owned key, so the start-up path can only be exercised as root.
test.skipIf(UID !== 0)('main.ts in paid mode: a bad key file refuses to start without echoing it; no OAuth store is needed; one paid writer per state directory, with no stale takeover', async () => {
  const dir = join(SAFE, 'main'), keys = join(SAFE, 'main-keys'); mkdirSync(dir); mkdirSync(keys);
  const secret = join(dir, 'caller'); writeFileSync(secret, SECRET);
  const cfgFile = (keyFile: string) => { const f = join(dir, `cfg-${Math.random()}.json`); writeFileSync(f, JSON.stringify({ port: 0, caller_secret_file: secret, state_dir: dir, auth_dir: join(dir, 'no-such-auth-dir'), routes: { 'gpt-6-luna': route }, ceilings: { per_hour: 600, per_day: 6000, concurrency: 2, usd_micro_per_day: CAP }, max_body_bytes: 262_144, upstream: { connect_ms: 1000, request_ms: 1000, auth: 'api_key', api_key_file: keyFile }, leak: {} })); return f; };
  const start = (cfg: string) => Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), cfg], { stdout: 'pipe', stderr: 'pipe' });
  const firstLine = (p: ReturnType<typeof start>) => new Promise<string>(res => { const rd = p.stdout.getReader(); rd.read().then(c => res(new TextDecoder().decode(c.value))); });
  const mk = (name: string, text: string, mode: number, where = keys) => { const f = join(where, name); writeFileSync(f, text); chmodSync(f, mode); return f; };
  for (const badKey of [mk('bad', 'sk-short with space SECRETVALUE', 0o640), mk('wide', GOOD_KEY + 'SECRETVALUE', 0o644), mk('in-state', GOOD_KEY + 'SECRETVALUE', 0o640, dir)]) {
    const bad = start(cfgFile(badKey)); expect(await bad.exited).not.toBe(0);
    const errText = await new Response(bad.stderr).text();
    expect(errText).toContain('API-KEY-FILE-INVALID'); expect(errText).not.toContain('SECRETVALUE');
  }
  const key = mk('key', GOOD_KEY + '\n', 0o640);
  writeFileSync(join(dir, 'paid-writer.lock'), '');                        // a leftover lock FILE from a dead writer holds nothing
  writeFileSync(join(dir, 'paid-writer.pid'), '1');                        // nor does an old pid file naming a live process
  const a = start(cfgFile(key));
  const first = await firstLine(a);
  expect(JSON.parse(first.trim().split('\n')[0])).toMatchObject({ event: 'listening', auth: 'api_key' });   // started with NO auth dir on disk
  expect(first).not.toContain('kkkk');
  const [b, c] = [start(cfgFile(key)), start(cfgFile(key))];               // two more at once: neither may displace the holder
  expect(await b.exited).not.toBe(0); expect(await c.exited).not.toBe(0);
  expect(await new Response(b.stderr).text()).toContain('PAID-WRITER-ALREADY-RUNNING');
  expect(await new Response(c.stderr).text()).toContain('PAID-WRITER-ALREADY-RUNNING');
  expect(a.exitCode).toBeNull();                                           // the first writer is still running
  a.kill('SIGKILL'); await a.exited;                                       // killed outright: the kernel drops the lock with it
  const d2 = start(cfgFile(key));
  expect(JSON.parse((await firstLine(d2)).trim().split('\n')[0])).toMatchObject({ event: 'listening' });
  d2.kill('SIGTERM'); await d2.exited;
  expect(existsSync(join(dir, 'no-such-auth-dir'))).toBe(false);
}, 60_000);

// S603: S590 masking re-landed on the paid branch. The masked request is converted to the PAID body, the rescan reads the
// exact projection that is sent, and the sentinel never reaches upstream.
test('S603 paid mode: a gitleaks hit is masked before the paid conversion; the rescanned text is the sent paid body; sentinel absent', async () => {
  const scanned: string[] = []; let n = 0;
  const s = setup({
    scan: async t => { scanned.push(t); return n++ === 0 ? { clean: false, detector: 'gitleaks', rules: ['generic-api-key'] } : { clean: true }; },
    mask: async p => ({ parts: p.map(x => x.replace('SENTINEL-S603-0000', '[REDACTED-BY-BRIDGE:generic-api-key]')), rules: ['generic-api-key'], spans: 1 }),
    body: { model: 'gpt-6-luna', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'icon_key: SENTINEL-S603-0000' }] },
  });
  const r = await s.post();
  expect(r.status).toBe(200); expect(r.headers.get('x-bridge-masked')).toBe('generic-api-key');
  expect(s.calls.length).toBe(1);
  const sent = s.calls[0].body;
  expect(JSON.stringify(sent)).not.toContain('SENTINEL-S603-0000');
  expect(sent).toMatchObject({ max_output_tokens: route.max_output_tokens, service_tier: 'default', prompt_cache_options: { mode: 'explicit' } });
  expect(sent.instructions).toBe('SYS' + MASK_NOTE);
  expect(sent.input).toEqual([{ role: 'user', content: 'icon_key: [REDACTED-BY-BRIDGE:generic-api-key]' }]);
  expect(scanned[1]).toBe([sent.instructions, ...sent.input.map((m: any) => m.content)].join('\n\n'));
  const row = rows(s.dir).at(-1); expect(row.masked).toEqual({ rules: ['generic-api-key'], spans: 1 }); expect(row.settled).toBe(true);
  expect(readFileSync(join(s.dir, 'requests.jsonl'), 'utf8')).not.toContain('SENTINEL-S603-0000');
});

test('S603 paid mode: a residual refusal is a 400 content block and reserves nothing', async () => {
  const s = setup({ scan: async () => ({ clean: false, detector: 'redactor', rules: ['2'] }) });
  const before = state(s.dir);
  const r = await s.post();
  expect(r.status).toBe(400); expect(r.headers.get('retry-after')).toBeNull();
  expect((await r.json()).error.innererror.code).toBe('content_policy_violation');
  expect(s.calls.length).toBe(0); expect(state(s.dir)).toEqual(before);
});
