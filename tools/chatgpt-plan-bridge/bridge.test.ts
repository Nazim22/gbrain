import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeHandler, type Config } from './bridge.ts';
import { Limits } from './limits.ts';
import { scan } from './leakgate.ts';
import { parseStream, type Upstream } from './upstream.ts';

const SECRET = 'a'.repeat(40);
const route = { model: 'gpt-6-luna', effort: 'medium' as const, max_output_chars: 64_000 };
const ev = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const item = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
// The real plan-route event sequence (P7 smoke): text only in output_item.done, completed.output is [].
const planStream = (text: string, out = 8, model = 'gpt-6-luna-2026-10-01') => ev('response.created', { response: { status: 'in_progress', output: [] } })
  + ev('response.output_text.delta', { delta: text }) + ev('response.output_item.done', { item: item(text) })
  + ev('response.completed', { response: { status: 'completed', model, output: [], usage: { input_tokens: 817, output_tokens: out } } });

function setup(over: Partial<{ upstream: (b: any) => Promise<Upstream>; token: () => Promise<string>; scan: (t: string) => Promise<any>; perHour: number; concurrency: number }> = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'bridge-test-'));
  const cfg: Config = { port: 0, caller_secret_file: '', state_dir: dir, auth_dir: '', routes: { 'gpt-6-luna': route }, ceilings: { per_hour: over.perHour ?? 100, per_day: 1000, concurrency: over.concurrency ?? 2 }, max_body_bytes: 262_144, upstream: { connect_ms: 1000, request_ms: 1000 }, leak: {} as any };
  const calls: any[] = [];
  const limits = new Limits(join(dir, 'counters.json'), cfg.ceilings);
  const h = makeHandler(cfg, {
    callerSecret: Buffer.from(SECRET), limits,
    accessToken: over.token ?? (async () => 'tok'),
    scan: over.scan ?? (async () => ({ clean: true })),
    upstream: async (body, token, bounds, maxChars) => { calls.push({ body, token, bounds, maxChars }); return over.upstream ? over.upstream(body) : { status: 200, raw: Buffer.from(planStream('{"atoms":[]}')), charCapHit: false }; },
  });
  const post = (body: unknown, secret = SECRET) => h(new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) }));
  return { dir, h, post, calls, limits, cfg };
}
const ok = { model: 'gpt-6-luna', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }], max_tokens: 8192 };

test('caller must present the bridge secret', async () => {
  const s = setup();
  expect((await s.post(ok, 'wrong-secret-of-another-length')).status).toBe(401);
  expect((await s.h(new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST', body: '{}' }))).status).toBe(401);
  expect(s.calls.length).toBe(0);
});

test('unsupported controls are refused with 400, never dropped', async () => {
  const s = setup();
  for (const [extra, code] of [[{ temperature: 0 }, 'unsupported:temperature'], [{ response_format: { type: 'json_object' } }, 'unsupported:response_format'], [{ tools: [] }, 'unsupported:tools'], [{ stream: true }, 'unsupported:stream'], [{ top_p: 1 }, 'unsupported:top_p']] as const) {
    const r = await s.post({ ...ok, ...extra }); expect(r.status).toBe(400); expect((await r.json()).error.code).toBe(code);
  }
  expect((await (await s.post({ ...ok, model: 'gpt-4' })).json()).error.code).toBe('unknown_model');
  expect((await (await s.post({ ...ok, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] })).json()).error.code).toBe('unsupported:non_text_content');
  expect(s.calls.length).toBe(0);
});

test('maps system+user to the only upstream shape the bridge sends', async () => {
  const s = setup(); const r = await s.post(ok);
  expect(r.status).toBe(200);
  expect(s.calls[0].body).toEqual({ model: 'gpt-6-luna', instructions: 'SYS', input: [{ role: 'user', content: 'USER' }], stream: true, store: false, reasoning: { effort: 'medium' } });
  expect(s.calls[0].maxChars).toBe(64_000);
});

test('plan-route stream (text only in output_item.done) becomes a chat completion with served model and usage', async () => {
  const s = setup(); const r = await s.post(ok); const b = await r.json();
  expect(b.choices[0].message.content).toBe('{"atoms":[]}'); expect(b.choices[0].finish_reason).toBe('stop');
  expect(b.model).toBe('gpt-6-luna-2026-10-01'); expect(b.usage).toEqual({ prompt_tokens: 817, completion_tokens: 8, total_tokens: 825 });
  expect(r.headers.get('x-bridge-effort')).toBe('medium'); expect(r.headers.get('x-bridge-served-model')).toBe('gpt-6-luna-2026-10-01');
});

test('max_tokens: an answer over the caller limit by the upstream count is delivered as length', async () => {
  const s = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(planStream('x', 9000)), charCapHit: false }) });
  expect((await (await s.post(ok)).json()).choices[0].finish_reason).toBe('length');
});

test('character bound: a stream cut at max_output_chars before its terminal event is delivered as length with the streamed text', () => {
  const raw = ev('response.created', { response: { status: 'in_progress', output: [] } }) + ev('response.output_text.delta', { delta: 'abc' });
  expect(parseStream(raw, true)).toEqual({ kind: 'completed', outcome: { text: 'abc', finish: 'length' } });
  expect(parseStream(raw, false)).toEqual({ kind: 'unknown' });
});

test('leak hit quarantines: transient 503, nothing sent, a quarantine row without text', async () => {
  const s = setup({ scan: async () => ({ clean: false, detector: 'redactor', rules: ['3'] }) });
  const r = await s.post({ ...ok, messages: [{ role: 'user', content: 'SECRET-MARKER-xyz' }] });
  expect(r.status).toBe(503); expect((await r.json()).error.code).toBe('leak_quarantine'); expect(s.calls.length).toBe(0);
  const q = readFileSync(join(s.dir, 'quarantine.jsonl'), 'utf8'); expect(q).toContain('"detector":"redactor"'); expect(q).not.toContain('SECRET-MARKER');
  expect(readFileSync(join(s.dir, 'requests.jsonl'), 'utf8')).not.toContain('SECRET-MARKER');
});

test('scanner failure blocks sending', async () => {
  const s = setup({ scan: async () => ({ error: 'gitleaks_failed' }) });
  const r = await s.post(ok); expect(r.status).toBe(503); expect((await r.json()).error.code).toBe('leak_gate_unavailable'); expect(s.calls.length).toBe(0);
});

test('runaway ceiling is durable across a restart and answers 429 with Retry-After', async () => {
  const s = setup({ perHour: 2 });
  expect((await s.post(ok)).status).toBe(200); expect((await s.post(ok)).status).toBe(200);
  const r = await s.post(ok); expect(r.status).toBe(429); expect((await r.json()).error.code).toBe('runaway_guard'); expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  const restarted = new Limits(join(s.dir, 'counters.json'), s.cfg.ceilings); expect(restarted.admit().ok).toBe(false);
  expect(s.calls.length).toBe(2);
});

test('concurrency bound answers busy', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const s = setup({ concurrency: 1, upstream: async () => { await gate; return { status: 200, raw: Buffer.from(planStream('[]')), charCapHit: false }; } });
  const first = s.post(ok); await Bun.sleep(5);
  const second = await s.post(ok); expect(second.status).toBe(429); expect((await second.json()).error.code).toBe('busy');
  release(); expect((await first).status).toBe(200);
});

test('auth failure is 401 (halts the caller phase) and sends nothing', async () => {
  const s = setup({ token: async () => { throw Error('REFRESH-UNKNOWN'); } });
  const r = await s.post(ok); expect(r.status).toBe(401); expect((await r.json()).error.message).toContain('oauth session expired'); expect(s.calls.length).toBe(0);
});

test('transport failure and a stream without a terminal event are unknown completions (502, transient)', async () => {
  const { UpstreamError } = await import('./upstream.ts');
  const a = setup({ upstream: async () => { throw new UpstreamError('REQUEST-TIMEOUT'); } });
  expect((await (await a.post(ok)).json()).error.code).toBe('unknown_completion');
  const b = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(ev('response.output_text.delta', { delta: 'x' })), charCapHit: false }) });
  const r = await b.post(ok); expect(r.status).toBe(502); expect((await r.json()).error.code).toBe('unknown_completion');
});

test('S561 capture only: a transport failure records the socket cause and how far the request got; the latch still trips', async () => {
  const { UpstreamError } = await import('./upstream.ts');
  const s = setup({ upstream: async () => { throw new UpstreamError('TRANSPORT-UNKNOWN', Buffer.alloc(0), 'ECONNRESET: socket hang up', true, false); } });
  const r = await s.post(ok); expect(r.status).toBe(502); expect((await r.json()).error.code).toBe('unknown_completion');
  const rows = readFileSync(join(s.dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const row = rows.find(x => x.code === 'unknown_completion');
  expect(row).toMatchObject({ detail: 'TRANSPORT-UNKNOWN', cause: 'ECONNRESET: socket hang up', connected: true, sent: false });
  expect(existsSync(join(s.dir, 'halted.json'))).toBe(true); // decision unchanged: still latches
});

test('provider limit codes map to 429/503; upstream 429 passes Retry-After', async () => {
  const lim = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(ev('response.failed', { response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })), charCapHit: false }) });
  expect((await lim.post(ok)).status).toBe(429);
  const un = setup({ upstream: async () => ({ status: 200, raw: Buffer.from(ev('response.failed', { response: { error: { code: 'subscription_sharing_usage_unavailable' } } })), charCapHit: false }) });
  expect((await un.post(ok)).status).toBe(503);
  const ra = setup({ upstream: async () => ({ status: 429, raw: Buffer.from('{"error":{"code":"rate_limit_exceeded"}}'), charCapHit: false, retryAfter: '17' }) });
  const r = await ra.post(ok); expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('17');
});

test('real pinned detectors: a synthetic token is caught by both; clean prose passes; a wrong pin is a scanner failure', async () => {
  const P = '/root/work/dream-s552-vault-atoms/pilot/detector/ingest-session-transcript.py';
  if (!existsSync(P)) throw Error('pinned redactor copy missing');
  const cfg = { python: '/usr/bin/python3', detector_check: join(import.meta.dir, 'detector_check.py'), redactor: P, redactor_sha256: '425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d', gitleaks: '/usr/local/bin/gitleaks', tmp_dir: process.env.TMPDIR ?? '/tmp', timeout_ms: 20_000 };
  const fake = 'ghp_' + 'Zq7RtY2uW9pLm3Nb5Vc8Xd1Kf4Hj6Gs0Ae2T';
  const hit = await scan(`deploy note: token ${fake} was used`, cfg);
  expect('clean' in hit && hit.clean === false).toBe(true);
  expect(await scan('The parser reads output_item.done when completed.output is empty.', cfg)).toEqual({ clean: true });
  expect(await scan('anything', { ...cfg, redactor_sha256: '0'.repeat(64) })).toEqual({ error: 'redactor_failed' });
}, 60_000);

test('halt latch: the first stop-class event trips it; later requests never reach upstream until cleared', async () => {
  const { UpstreamError } = await import('./upstream.ts');
  const { rmSync, existsSync: ex } = await import('node:fs');
  let fail = true;
  const s = setup({ upstream: async () => { if (fail) throw new UpstreamError('REQUEST-TIMEOUT'); return { status: 200, raw: Buffer.from(planStream('[]')), charCapHit: false }; } });
  expect((await s.post(ok)).status).toBe(502);                       // unknown_completion trips the latch
  expect(ex(join(s.dir, 'halted.json'))).toBe(true);
  fail = false;
  const r = await s.post(ok); expect(r.status).toBe(429); expect((await r.json()).error.code).toBe('bridge_halted');
  expect(s.calls.length).toBe(1);                                    // the refused request made no upstream call
  const st = await (await s.h(new Request('http://127.0.0.1/v1/bridge/status', { headers: { authorization: `Bearer ${SECRET}` } }))).json();
  expect(st.halted.code).toBe('unknown_completion');
  rmSync(join(s.dir, 'halted.json'));                                // operator clears it
  expect((await s.post(ok)).status).toBe(200);
});

test('halt latch: non-stop errors (busy, leak quarantine, provider limits) do not trip it', async () => {
  const s = setup({ scan: async () => ({ clean: false, detector: 'redactor', rules: ['2'] }) });
  expect((await s.post(ok)).status).toBe(503);
  const { existsSync: ex } = await import('node:fs');
  expect(ex(join(s.dir, 'halted.json'))).toBe(false);
});

test('halt latch fails closed: an empty or malformed halted.json blocks every request', async () => {
  const { writeFileSync } = await import('node:fs');
  for (const content of ['', '{not json', 'null']) {
    const s = setup();
    writeFileSync(join(s.dir, 'halted.json'), content);
    const r = await s.post(ok); expect(r.status).toBe(429); expect((await r.json()).error.code).toBe('bridge_halted');
    expect(s.calls.length).toBe(0);
  }
});

test('halt latch is re-checked right before dispatch: a request held in scanning does not cross a trip', async () => {
  const { UpstreamError } = await import('./upstream.ts');
  let releaseScan!: () => void; const scanGate = new Promise<void>(r => { releaseScan = r; });
  let scans = 0, upstreamCalls = 0;
  const s = setup({
    scan: async () => { scans++; if (scans === 1) await scanGate; return { clean: true }; },          // request A is held in scanning
    upstream: async () => { upstreamCalls++; throw new UpstreamError('REQUEST-TIMEOUT'); },          // request B trips the latch
  });
  const a = s.post(ok); await Bun.sleep(5);
  expect((await s.post(ok)).status).toBe(502);       // B: unknown_completion → latch tripped
  expect(upstreamCalls).toBe(1);
  releaseScan();
  const ra = await a; expect(ra.status).toBe(429); expect((await ra.json()).error.code).toBe('bridge_halted');
  expect(upstreamCalls).toBe(1);                      // A never dispatched
});
