/**
 * S603 artifact check: run the leak-gate behaviour of a CANDIDATE BUNDLE against its own bytes, before install swaps it in.
 * Usage: bun artifact_check.ts <bundle.js> <candidate-config.json>   exit 0 = every case held, 1 = any case failed.
 *
 * It imports the bundle (never the source), so a bundle whose safety code was removed or reverted fails here even when
 * its git ancestry is fine. The bundle's own makeHandler, scan and maskGitleaks run over the detectors the candidate
 * config names. Upstream, token and state are scratch: nothing leaves the box, and the live state dir is never touched.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [bundle, cfgPath] = process.argv.slice(2);
const fails: string[] = [];
const check = (name: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) fails.push(name); };

const m = await import(bundle).catch(e => ({ __err: String(e?.message ?? e) }));
const need = ['makeHandler', 'scan', 'maskGitleaks', 'Limits'];
const missing = need.filter(k => typeof (m as any)[k] !== 'function');
check(`bundle exports ${need.join('/')}`, missing.length === 0);
if (missing.length) { console.log(`missing: ${missing.join(',')}`); process.exit(1); }
const { makeHandler, scan, maskGitleaks, Limits } = m as any;

const live = JSON.parse(readFileSync(cfgPath, 'utf8'));
const SECRET = 's603-artifact-check-'.padEnd(40, 'x');
const ev = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const okStream = ev('response.output_item.done', { item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"atoms":[]}' }] } })
  + ev('response.completed', { response: { status: 'completed', model: 'gpt-6-luna', output: [], usage: { input_tokens: 10, output_tokens: 5 }, service_tier: 'default' } });
const alias = Object.keys(live.routes)[0];

const paid = live.upstream?.auth === 'api_key';
function handler(over: { scan?: (t: string) => Promise<any> } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 's603-artifact-'));
  const tmp = mkdtempSync(join(dir, 'tmp-'));
  const now = Date.now();
  writeFileSync(join(dir, 'counters.json'), JSON.stringify({ hour_start: now, hour: 0, day_start: now, day: 0, spend: {} }));
  const leak = { ...live.leak, tmp_dir: tmp };
  const cfg = { ...live, state_dir: dir, leak };
  const calls: any[] = []; const scanned: string[] = [];
  const h = makeHandler(cfg, {
    callerSecret: Buffer.from(SECRET), limits: new Limits(join(dir, 'counters.json'), cfg.ceilings),
    accessToken: async () => 'artifact-check-token',
    scan: over.scan ?? ((t: string) => { scanned.push(t); return scan(t, leak); }), mask: (p: string[]) => maskGitleaks(p, leak),
    upstream: async (body: any) => { calls.push(body); return { status: 200, raw: Buffer.from(okStream), charCapHit: false }; },
  });
  const post = (content: string) => h(new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ model: alias, messages: [{ role: 'system', content: 'Extract atoms.' }, { role: 'user', content }] }) }));
  return { dir, calls, post, scanned };
}

// Fixtures are the real-detector ones from bridge.test.ts: a gitleaks-only generic-api-key hit, and a redactor hit.
const GL = 'bev-energy-' + 'Qx7mK2pL9vR4tW8z', RED = 'apiKey = "' + 'Zx81Kq3Lm9Pv2Rt7Wy4Nc6' + '"';
const scratch: string[] = [];
try {
  const a = handler(); scratch.push(a.dir);
  const ra = await a.post(`product row\n  icon_key: "${GL}"\n  name: Rip It Citrus`);
  const sentA = JSON.stringify(a.calls[0] ?? {});
  check('(a) gitleaks hit: 200, masked header, one send', ra.status === 200 && ra.headers.get('x-bridge-masked') === 'generic-api-key' && a.calls.length === 1);
  check('(a) sent body carries no sentinel and does carry the mask marker', !sentA.includes(GL) && sentA.includes('[REDACTED-BY-BRIDGE:generic-api-key]'));
  const sentText = a.calls[0] ? [a.calls[0].instructions, ...a.calls[0].input.map((m: any) => m.content)].join('\n\n') : '';
  check('(a) the rescanned text is exactly the text of the body that was sent', a.scanned.length === 2 && a.scanned[1] === sentText);
  if (paid) check('(a) paid mode: the sent body is the paid shape (output cap, default tier, explicit caching)',
    a.calls[0]?.service_tier === 'default' && Number.isInteger(a.calls[0]?.max_output_tokens) && a.calls[0]?.prompt_cache_options?.mode === 'explicit');
  console.log(`mode ${paid ? 'paid' : 'plan'}`);
  const rowA = readFileSync(join(a.dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  check('(a) ledger row records masked, without the sentinel', !!rowA?.masked && !JSON.stringify(rowA).includes(GL));

  const b = handler(); scratch.push(b.dir);
  const rb = await b.post(RED); const bb = await rb.json().catch(() => ({}));
  check('(b) redactor hit: 400 content block, no retry-after, nothing sent', rb.status === 400 && rb.headers.get('retry-after') === null
    && bb?.error?.code === 'leak_quarantine' && bb?.error?.innererror?.code === 'content_policy_violation' && b.calls.length === 0);

  const c = handler({ scan: async () => { throw Error('scanner exploded'); } }); scratch.push(c.dir);
  const rc = await c.post('hello'); const rc2 = await c.post('hello');
  check('(c) throwing scan: 503 leak_gate_unavailable, latch written, next request 429, nothing sent',
    rc.status === 503 && (await rc.json().catch(() => ({})))?.error?.code === 'leak_gate_unavailable' && existsSync(join(c.dir, 'halted.json')) && rc2.status === 429 && c.calls.length === 0);

  const d = handler(); scratch.push(d.dir);
  const rd = await d.post('a plain sentence about inventory');
  check('(d) clean request: 200, sent unchanged', rd.status === 200 && d.calls.length === 1 && d.calls[0].input?.[0]?.content === 'a plain sentence about inventory');
} catch (e: any) {
  check(`no exception (${String(e?.message ?? e).slice(0, 120)})`, false);
} finally {
  for (const s of scratch) rmSync(s, { recursive: true, force: true });
}
console.log(fails.length ? `ARTIFACT CHECK FAILED (${fails.length})` : 'ARTIFACT CHECK PASSED');
process.exit(fails.length ? 1 : 0);
