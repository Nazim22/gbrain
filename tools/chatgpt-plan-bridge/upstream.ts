/**
 * One upstream Responses call on the plan route (design §2, §6). Transport pattern from the reviewed eval
 * (eval/chatgpt-plan/adapter.ts @1066d3fc): fresh socket per request, connect + request deadlines, no redirects,
 * byte cap. Adds an incremental CHARACTER bound on streamed answer text (max_output_chars).
 */
import { request as httpsRequest } from 'node:https';
import { createParser } from 'eventsource-parser';
import type { Outcome } from './contract.ts';

export const RESPONSES = 'https://api.openai.com/v1/responses';
export const STREAM_MAX_BYTES = 2 * 1024 * 1024;
export type Upstream = { status: number; raw: Buffer; charCapHit: boolean; retryAfter?: string };
export type UpstreamSender = (body: unknown, accessToken: string, bounds: { connect: number; request: number }, maxChars: number) => Promise<Upstream>;
export class UpstreamError extends Error { constructor(readonly code: string, readonly raw?: Buffer) { super(code); } }

export const sendUpstream: UpstreamSender = (body, accessToken, bounds, maxChars) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  let finished = false, size = 0, deltaChars = 0;
  const chunks: Buffer[] = [];
  const counter = createParser({ onEvent: e => {
    try { const d = JSON.parse(e.data); if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') deltaChars += d.delta.length; } catch { /* the terminal parser judges malformed events */ }
  } });
  const done = (v: Upstream) => { if (finished) return; finished = true; clearTimeout(connect); clearTimeout(deadline); resolve(v); };
  const fail = (code: string) => { if (finished) return; finished = true; clearTimeout(connect); clearTimeout(deadline); req.destroy(); reject(new UpstreamError(code, Buffer.concat(chunks))); };
  const req = httpsRequest(RESPONSES, { agent: false, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }, res => {
    clearTimeout(connect);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) { res.destroy(); fail('REDIRECT'); return; }
    res.on('data', (c: Buffer) => {
      size += c.length; if (size > STREAM_MAX_BYTES) { fail('OUTPUT-BOUND'); return; }
      chunks.push(c);
      if (status === 200) { counter.feed(c.toString()); if (deltaChars > maxChars) { req.destroy(); done({ status, raw: Buffer.concat(chunks), charCapHit: true }); } }
    });
    res.on('aborted', () => fail('DISCONNECTED')); res.on('error', () => fail('DISCONNECTED'));
    res.on('end', () => done({ status, raw: Buffer.concat(chunks), charCapHit: false, retryAfter: res.headers['retry-after'] as string | undefined }));
  });
  const connect = setTimeout(() => fail('CONNECT-TIMEOUT'), bounds.connect);
  const deadline = setTimeout(() => fail('REQUEST-TIMEOUT'), bounds.request);
  req.on('socket', s => s.once('secureConnect', () => clearTimeout(connect)));
  req.on('error', () => fail('TRANSPORT-UNKNOWN'));
  req.end(data);
});

/**
 * Terminal parse of a plan-route stream into answer text (rules of the reviewed parseLuna, generalised to text):
 * exactly one terminal event; text from output_item.done when completed.output is [] (the P7 finding);
 * both present and different, or an item after the terminal event = malformed.
 */
export type Parsed = { kind: 'completed'; outcome: Outcome } | { kind: 'failed'; code: string } | { kind: 'unknown' };
const SAFE = new Set(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'invalid_request_error', 'unsupported_parameter', 'server_error', 'rate_limit_exceeded']);
export function parseStream(raw: string, charCapHit = false): Parsed {
  let terminal: Parsed | undefined, malformed = false, sawTerminal = false, partial = '';
  const items: any[] = [];
  const p = createParser({ onError: () => { malformed = true; }, onEvent: e => {
    if (e.data === '[DONE]') return;
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') { partial += d.delta; return; }
      if (d.type === 'response.output_item.done') { if (sawTerminal) malformed = true; else items.push(d.item); return; }
      if (!['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(d.type)) return;
      if (sawTerminal) { malformed = true; return; } sawTerminal = true;
      const r = d.response;
      if (d.type === 'response.incomplete') { terminal = { kind: 'completed', outcome: { text: textOf(r?.output?.length ? r.output : items), finish: 'length', served: r?.model, usage: usageOf(r) } }; return; }
      if (d.type !== 'response.completed') { const c = r?.error?.code ?? d.code ?? d.error?.code; terminal = { kind: 'failed', code: typeof c === 'string' && SAFE.has(c) ? c : 'UNKNOWN' }; return; }
      if (r?.status !== 'completed' || !Array.isArray(r.output)) { malformed = true; return; }
      if (r.output.length && items.length && JSON.stringify(r.output) !== JSON.stringify(items)) { malformed = true; return; }
      const out = r.output.length ? r.output : items;
      const contents = out.filter((o: any) => o?.type === 'message').flatMap((o: any) => o.content ?? []);
      if (contents.some((c: any) => c.type === 'refusal')) { terminal = { kind: 'completed', outcome: { text: '', finish: 'content_filter', served: r.model, usage: usageOf(r) } }; return; }
      terminal = { kind: 'completed', outcome: { text: textOf(out), finish: 'stop', served: r.model, usage: usageOf(r) } };
    } catch { malformed = true; }
  } });
  try { p.feed(raw); p.reset({ consume: true }); } catch { malformed = true; }
  // The character bound stops the stream before any terminal event: deliver what was streamed, marked truncated.
  if (charCapHit && !sawTerminal && !malformed) return { kind: 'completed', outcome: { text: partial, finish: 'length' } };
  return malformed ? { kind: 'unknown' } : terminal ?? { kind: 'unknown' };
}
function textOf(out: any[]) { return out.filter((o: any) => o?.type === 'message').flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === 'output_text' && typeof c.text === 'string').map((c: any) => c.text).join(''); }
function usageOf(r: any) { return { input_tokens: r?.usage?.input_tokens, output_tokens: r?.usage?.output_tokens }; }
