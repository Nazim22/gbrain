/**
 * chatgpt-plan-bridge: an OpenAI Chat Completions endpoint on 127.0.0.1 that serves configured routes through
 * a ChatGPT plan's official "Sign in with ChatGPT" Responses route. Design: /root/work/dream-s552-luna/DESIGN.md.
 * Every failure maps to an explicit HTTP status a client can act on; nothing a caller asks for is silently dropped.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ContractError, applyMaxTokens, chatCompletion, parseChatRequest, responsesBody, type Route } from './contract.ts';
import { parseStream, UpstreamError, type UpstreamSender } from './upstream.ts';
import { Limits, type Ceilings } from './limits.ts';
import type { LeakConfig, LeakResult } from './leakgate.ts';

export type Config = {
  port: number; caller_secret_file: string; state_dir: string; auth_dir: string;
  routes: Record<string, Route>; ceilings: Ceilings; max_body_bytes: number;
  upstream: { connect_ms: number; request_ms: number }; leak: LeakConfig;
  /** Response codes that trip the durable halt latch: every later request is refused before any upstream call. */
  halt_on?: string[];
};
export const DEFAULT_HALT_ON = ['unknown_completion', 'leak_gate_unavailable', 'auth_unavailable', 'upstream_auth', 'runaway_guard'];
export type Deps = {
  accessToken: () => Promise<string>;          // load, refresh when near expiry (single owner, flock); throws on failure
  upstream: UpstreamSender;
  scan: (text: string) => Promise<LeakResult>;
  limits: Limits;
  callerSecret: Buffer;
  now?: () => number;
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (status: number, code: string, message = code, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message, type: status >= 500 ? 'server_error' : 'invalid_request_error' } }, headers);

export function makeHandler(cfg: Config, d: Deps) {
  const now = d.now ?? Date.now;
  const ledger = (row: Record<string, unknown>) => appendFileSync(join(cfg.state_dir, 'requests.jsonl'), JSON.stringify({ ts: new Date(now()).toISOString(), ...row }) + '\n', { mode: 0o600 });
  const quarantine = (row: Record<string, unknown>) => appendFileSync(join(cfg.state_dir, 'quarantine.jsonl'), JSON.stringify({ ts: new Date(now()).toISOString(), ...row }) + '\n', { mode: 0o600 });
  const haltOn = new Set(cfg.halt_on ?? DEFAULT_HALT_ON);
  const haltFile = join(cfg.state_dir, 'halted.json');
  const trip = (code: string, id: string) => {
    if (!haltOn.has(code) || existsSync(haltFile)) return;
    const fd = openSync(haltFile, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ ts: new Date(now()).toISOString(), code, request_id: id })); fsyncSync(fd); } finally { closeSync(fd); }
  };
  // Fail closed: only "no latch file" means not halted. An unreadable or malformed latch counts as halted.
  const halted = () => {
    let text: string;
    try { text = readFileSync(haltFile, 'utf8'); } catch (e: any) { return e?.code === 'ENOENT' ? null : { code: 'latch_unreadable' }; }
    try { const h = JSON.parse(text); return h && typeof h === 'object' ? h : { code: 'latch_malformed' }; } catch { return { code: 'latch_malformed' }; }
  };
  const authorized = (req: Request) => {
    const h = req.headers.get('authorization') ?? '';
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    return got.length === d.callerSecret.length && timingSafeEqual(got, d.callerSecret);
  };

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!authorized(req)) return err(401, 'caller_unauthorized');
    if (req.method === 'GET' && url.pathname === '/v1/bridge/status') return json(200, { limits: d.limits.snapshot(), routes: Object.keys(cfg.routes), halted: halted() });
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return err(404, 'not_found');
    const id = randomUUID(), started = now();
    // Halt latch: once a stop-class event happened, nothing reaches upstream until an operator clears halted.json.
    const h = halted();
    if (h) { ledger({ id, status: 429, code: 'bridge_halted', halted_by: h.code }); return err(429, 'bridge_halted', `bridge halted by ${h.code}; operator must clear halted.json`, { 'retry-after': '3600' }); }
    const raw = await req.text();
    if (Buffer.byteLength(raw) > cfg.max_body_bytes) return err(413, 'body_too_large');
    let parsed;
    try { parsed = parseChatRequest(JSON.parse(raw), cfg.routes); }
    catch (e) { const c = e instanceof ContractError ? e : new ContractError(400, 'invalid_json_body'); ledger({ id, status: c.status, code: c.code }); return err(c.status, c.code); }
    const outbound = [parsed.instructions, ...parsed.input.map(m => m.content)].join('\n\n');
    const base = { id, alias: parsed.alias, model: parsed.route.model, effort: parsed.route.effort, instructions_sha256: sha(parsed.instructions), input_sha256: sha(JSON.stringify(parsed.input)) };

    const leak = await d.scan(outbound);
    if ('error' in leak) { ledger({ ...base, status: 503, code: 'leak_gate_unavailable' }); trip('leak_gate_unavailable', id); return err(503, 'leak_gate_unavailable', 'leak gate unavailable; not sent', { 'retry-after': '60' }); }
    if (!leak.clean) {
      quarantine({ id, alias: parsed.alias, input_sha256: base.input_sha256, detector: leak.detector, rules: leak.rules });
      ledger({ ...base, status: 503, code: 'leak_quarantine' });
      return err(503, 'leak_quarantine', 'outbound text matched the leak gate; not sent', { 'retry-after': '3600' });
    }

    const adm = d.limits.admit();
    if (!adm.ok) { ledger({ ...base, status: 429, code: adm.code }); trip(adm.code, id); return err(429, adm.code, adm.code, { 'retry-after': String(adm.retryAfterS) }); }
    try {
      let token: string;
      try { token = await d.accessToken(); }
      catch { ledger({ ...base, status: 401, code: 'auth_unavailable' }); trip('auth_unavailable', id); return err(401, 'auth_unavailable', 'oauth session expired or unavailable'); }
      // Re-check the latch immediately before dispatch: another request may have tripped it while this one was scanning.
      const h2 = halted();
      if (h2) { ledger({ ...base, status: 429, code: 'bridge_halted', halted_by: h2.code }); return err(429, 'bridge_halted', `bridge halted by ${h2.code}; operator must clear halted.json`, { 'retry-after': '3600' }); }
      let up;
      try { up = await d.upstream(responsesBody(parsed), token, { connect: cfg.upstream.connect_ms, request: cfg.upstream.request_ms }, parsed.route.max_output_chars); }
      catch (e) {
        const code = e instanceof UpstreamError ? e.code : 'TRANSPORT-UNKNOWN';
        // S561 capture only: the socket error and how far the request got, so a drop names its cause. Decision unchanged.
        const why = e instanceof UpstreamError ? { cause: e.cause, connected: e.connected, sent: e.sent } : { cause: String((e as Error)?.message ?? e).slice(0, 200) };
        ledger({ ...base, status: 502, code: 'unknown_completion', detail: code, ...why, latency_ms: now() - started }); trip('unknown_completion', id); return err(502, 'unknown_completion', code);
      }
      if (up.status !== 200) {
        let code = 'upstream_error';
        try { const b = JSON.parse(up.raw.toString()); if (typeof b?.error?.code === 'string') code = b.error.code; } catch { /* keep generic */ }
        const status = up.status === 429 ? 429 : up.status === 503 ? 503 : up.status === 401 || up.status === 403 ? 401 : up.status === 400 ? 400 : 502;
        ledger({ ...base, status, code, upstream_status: up.status, latency_ms: now() - started });
        if (up.status === 401 || up.status === 403) trip('upstream_auth', id);
        return err(status, code, code, up.retryAfter ? { 'retry-after': up.retryAfter } : {});
      }
      const p = parseStream(up.raw.toString(), up.charCapHit);
      if (p.kind === 'unknown') { ledger({ ...base, status: 502, code: 'unknown_completion', latency_ms: now() - started }); trip('unknown_completion', id); return err(502, 'unknown_completion'); }
      if (p.kind === 'failed') {
        const status = p.code === 'subscription_sharing_usage_limit_exceeded' || p.code === 'rate_limit_exceeded' ? 429 : p.code === 'subscription_sharing_usage_unavailable' ? 503 : 502;
        ledger({ ...base, status, code: p.code, latency_ms: now() - started });
        return err(status, p.code);
      }
      const o = applyMaxTokens(p.outcome, parsed.maxTokens);
      ledger({ ...base, status: 200, finish: o.finish, served: o.served ?? null, usage: o.usage ?? null, char_cap_hit: up.charCapHit, latency_ms: now() - started });
      return json(200, chatCompletion(o, parsed.alias, id), { 'x-bridge-request-id': id, 'x-bridge-effort': parsed.route.effort, 'x-bridge-served-model': o.served ?? parsed.route.model });
    } finally { adm.release(); }
  };
}

export function loadConfig(path: string): Config {
  const c = JSON.parse(readFileSync(path, 'utf8')) as Config;
  if (!Number.isInteger(c.port) || !c.routes || !Object.keys(c.routes).length) throw Error('CONFIG');
  for (const r of Object.values(c.routes)) if (!r.model || !r.effort || !(r.max_output_chars > 0)) throw Error('CONFIG-ROUTE');
  return c;
}
