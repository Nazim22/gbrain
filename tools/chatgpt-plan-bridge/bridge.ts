/**
 * chatgpt-plan-bridge: an OpenAI Chat Completions endpoint on 127.0.0.1 that serves configured routes through
 * a ChatGPT plan's official "Sign in with ChatGPT" Responses route. Design: /root/work/dream-s552-luna/DESIGN.md.
 * Every failure maps to an explicit HTTP status a client can act on; nothing a caller asks for is silently dropped.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ContractError, applyMaxTokens, chatCompletion, costMicro, paidResponsesBody, parseChatRequest, reservationMicro, responsesBody, type Route } from './contract.ts';
import { parseStream, UpstreamError, type UpstreamSender } from './upstream.ts';
import { BudgetStateError, Limits, fsyncDir, type Ceilings } from './limits.ts';
import type { LeakConfig, LeakResult } from './leakgate.ts';

export type Config = {
  port: number; caller_secret_file: string; state_dir: string; auth_dir: string;
  routes: Record<string, Route>; ceilings: Ceilings; max_body_bytes: number;
  /** auth 'api_key' = paid OpenAI API mode: bearer from api_key_file, paid request body, dollar ceiling. Default 'plan'. */
  upstream: { connect_ms: number; request_ms: number; auth?: 'plan' | 'api_key'; api_key_file?: string }; leak: LeakConfig;
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
  const paid = cfg.upstream.auth === 'api_key';
  // budget_invariant always latches in paid mode, whatever halt_on says: it means the ceiling's assumptions were broken.
  const haltOn = new Set([...(cfg.halt_on ?? DEFAULT_HALT_ON), ...(paid ? ['budget_invariant'] : [])]);
  const haltFile = join(cfg.state_dir, 'halted.json');
  // The in-process latch is set BEFORE the durable one is attempted and dropped only once the latch file and its
  // directory entry are on disk. If that write fails (the error propagates), this process still refuses every later
  // request; once it succeeds the file alone governs, so an operator clears a halt exactly as before.
  let memHalt: { code: string } | null = null;
  const trip = (code: string, id: string) => {
    if (!haltOn.has(code)) return;
    memHalt ??= { code };
    if (!existsSync(haltFile)) {
      const fd = openSync(haltFile, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ ts: new Date(now()).toISOString(), code, request_id: id })); fsyncSync(fd); } finally { closeSync(fd); }
    }
    fsyncDir(cfg.state_dir);
    memHalt = null;
  };
  // Fail closed: only "no latch file" means not halted. An unreadable or malformed latch counts as halted.
  const halted = () => {
    if (memHalt) return memHalt;
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

    // Paid mode: the request's maximum cost is reserved durably here, with the call counters, before anything is sent.
    const adm = d.limits.admit(paid ? reservationMicro(parsed.route) : undefined);
    if (!adm.ok) {
      const status = adm.code === 'budget_state_unavailable' ? 503 : 429;
      // Paid mode: spend state that cannot be trusted is an invariant breach. It latches until an operator clears it;
      // the counters are left exactly as found.
      ledger({ ...base, status, code: adm.code }); trip(paid && adm.code === 'budget_state_unavailable' ? 'budget_invariant' : adm.code, id);
      return err(status, adm.code, adm.code, { 'retry-after': String(adm.retryAfterS) });
    }
    const money = paid ? { reserved_micro: adm.reserved, spend_day: adm.day } : {};
    // Every ending except a 200 with complete in-bound usage keeps the full reservation (it may have been billed).
    const settleFrom = (o: { usage?: { input_tokens?: number; output_tokens?: number }; tier?: unknown }): Record<string, unknown> => {
      if (!paid) return {};
      // The bridge cut the stream itself before a terminal event: nothing to judge, the full reservation stays.
      if (o.cut) return { ...money, settled: false, unsettled: 'stream_cut_before_terminal' };
      // The tier is judged FIRST and on its own: a terminal answer on any tier but "default" (or with none) halts,
      // whether or not its usage is readable.
      if (o.tier !== 'default') { trip('budget_invariant', id); return { ...money, settled: false, unsettled: 'service_tier_not_default' }; }
      const r = parsed.route, u = o.usage ?? {}, i = u.input_tokens, out = u.output_tokens;
      const ints = Number.isSafeInteger(i) && Number.isSafeInteger(out) && (i as number) >= 0 && (out as number) >= 0;
      if (!ints) return { ...money, settled: false, unsettled: 'usage_missing_or_malformed' };
      if ((i as number) > r.max_input_tokens! || (out as number) > r.max_output_tokens!) { trip('budget_invariant', id); return { ...money, settled: false, unsettled: 'usage_over_bound' }; }
      const actual = costMicro(i as number, r.price_micro_per_mtok!.input) + costMicro(out as number, r.price_micro_per_mtok!.output);
      try { adm.settle!(actual); }
      catch (e) { if (!(e instanceof BudgetStateError)) throw e; trip('budget_invariant', id); return { ...money, settled: false, unsettled: 'spend_state_invalid' }; }
      return { ...money, settled: true, settled_micro: actual };
    };
    try {
      let token: string;
      try { token = await d.accessToken(); }
      catch { ledger({ ...base, ...money, status: 401, code: 'auth_unavailable' }); trip('auth_unavailable', id); return err(401, 'auth_unavailable', 'oauth session expired or unavailable'); }
      // Re-check the latch immediately before dispatch: another request may have tripped it while this one was scanning.
      const h2 = halted();
      if (h2) { ledger({ ...base, status: 429, code: 'bridge_halted', halted_by: h2.code }); return err(429, 'bridge_halted', `bridge halted by ${h2.code}; operator must clear halted.json`, { 'retry-after': '3600' }); }
      let up;
      try { up = await d.upstream(paid ? paidResponsesBody(parsed) : responsesBody(parsed), token, { connect: cfg.upstream.connect_ms, request: cfg.upstream.request_ms }, parsed.route.max_output_chars); }
      catch (e) { const code = e instanceof UpstreamError ? e.code : 'TRANSPORT-UNKNOWN'; ledger({ ...base, ...money, status: 502, code: 'unknown_completion', detail: code, latency_ms: now() - started }); trip('unknown_completion', id); return err(502, 'unknown_completion', code); }
      if (up.status !== 200) {
        let code = 'upstream_error';
        try { const b = JSON.parse(up.raw.toString()); if (typeof b?.error?.code === 'string') code = b.error.code; } catch { /* keep generic */ }
        const status = up.status === 429 ? 429 : up.status === 503 ? 503 : up.status === 401 || up.status === 403 ? 401 : up.status === 400 ? 400 : 502;
        ledger({ ...base, ...money, status, code, upstream_status: up.status, latency_ms: now() - started });
        if (up.status === 401 || up.status === 403) trip('upstream_auth', id);
        return err(status, code, code, up.retryAfter ? { 'retry-after': up.retryAfter } : {});
      }
      const p = parseStream(up.raw.toString(), up.charCapHit);
      if (p.kind === 'unknown') { ledger({ ...base, ...money, status: 502, code: 'unknown_completion', latency_ms: now() - started }); trip('unknown_completion', id); return err(502, 'unknown_completion'); }
      if (p.kind === 'failed') {
        const status = ['subscription_sharing_usage_limit_exceeded', 'rate_limit_exceeded', 'insufficient_quota', 'billing_hard_limit_reached'].includes(p.code) ? 429 : p.code === 'subscription_sharing_usage_unavailable' ? 503 : 502;
        ledger({ ...base, ...money, status, code: p.code, latency_ms: now() - started });
        return err(status, p.code);
      }
      const o = applyMaxTokens(p.outcome, parsed.maxTokens);
      ledger({ ...base, status: 200, finish: o.finish, served: o.served ?? null, usage: o.usage ?? null, char_cap_hit: up.charCapHit, latency_ms: now() - started, ...settleFrom(p.outcome) });
      return json(200, chatCompletion(o, parsed.alias, id), { 'x-bridge-request-id': id, 'x-bridge-effort': parsed.route.effort, 'x-bridge-served-model': o.served ?? parsed.route.model });
    } finally { adm.release(); }
  };
}

/**
 * The reviewed paid routes (GBRAIN-S593 frozen design). The dollar ceiling is only as good as these numbers, so a paid
 * config may be MORE conservative (a larger input maximum, a smaller output cap, a higher price) and never less.
 * Prices in micro-dollars per 1M tokens: the long-context input rate with 30-minute cache writes, and long-context output.
 */
export const PAID_ROUTES: Record<string, { min_input_tokens: number; max_output_tokens: number; min_price: { input: number; output: number } }> = {
  'gpt-6-luna': { min_input_tokens: 1_050_000, max_output_tokens: 16_000, min_price: { input: 250_000, output: 750_000 } },
};
/** The owner's ceiling: $10 per UTC day. A paid config may set less, never more. */
export const OWNER_CAP_MICRO = 10_000_000;
const SANE_MAX = 1_000_000_000;   // keeps every product and sum far inside exact integer range

export function loadConfig(path: string): Config {
  const c = JSON.parse(readFileSync(path, 'utf8')) as Config;
  if (!Number.isInteger(c.port) || !c.routes || !Object.keys(c.routes).length) throw Error('CONFIG');
  for (const r of Object.values(c.routes)) if (!r.model || !r.effort || !(r.max_output_chars > 0)) throw Error('CONFIG-ROUTE');
  const auth = c.upstream?.auth ?? 'plan';
  if (auth !== 'plan' && auth !== 'api_key') throw Error('CONFIG-AUTH');
  if (auth === 'api_key') {
    const pos = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
    if (typeof c.upstream.api_key_file !== 'string' || !c.upstream.api_key_file.startsWith('/')) throw Error('CONFIG-API-KEY-FILE');
    if (!pos(c.ceilings?.usd_micro_per_day) || c.ceilings.usd_micro_per_day! > OWNER_CAP_MICRO) throw Error('CONFIG-BUDGET');
    if (!pos(c.ceilings.concurrency) || !pos(c.ceilings.per_hour) || !pos(c.ceilings.per_day)) throw Error('CONFIG-CEILINGS');
    for (const r of Object.values(c.routes)) {
      const pin = Object.hasOwn(PAID_ROUTES, r.model) ? PAID_ROUTES[r.model] : null;
      if (!pin) throw Error('CONFIG-ROUTE-PAID-MODEL');
      const vals = [r.max_input_tokens, r.max_output_tokens, r.price_micro_per_mtok?.input, r.price_micro_per_mtok?.output];
      if (!vals.every(v => pos(v) && (v as number) <= SANE_MAX)) throw Error('CONFIG-ROUTE-PAID');
      if (r.max_input_tokens! < pin.min_input_tokens || r.max_output_tokens! > pin.max_output_tokens
        || r.price_micro_per_mtok!.input < pin.min_price.input || r.price_micro_per_mtok!.output < pin.min_price.output) throw Error('CONFIG-ROUTE-PAID-PIN');
      // Usable only if every concurrent request can hold its FULL (input + output) reservation inside the day's ceiling.
      if (reservationMicro(r) * c.ceilings.concurrency > c.ceilings.usd_micro_per_day!) throw Error('CONFIG-BUDGET-UNUSABLE');
    }
  }
  return c;
}
