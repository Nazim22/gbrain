/**
 * Real-path check (no network): gbrain's own gateway `chat()` → `litellm:` recipe → this bridge's real handler →
 * a STUB upstream returning the recorded plan-route event shape. Proves the exact body gbrain sends passes the
 * contract, and what gbrain reads back (text, served model). Run: bun tools/chatgpt-plan-bridge/gbrain-path.check.ts
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { makeHandler, type Config } from './bridge.ts';
import { Limits } from './limits.ts';

const SECRET = 'b'.repeat(48);
const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'bridge-path-'));
const cfg: Config = { port: 0, caller_secret_file: '', state_dir: dir, auth_dir: '', routes: { 'gpt-6-luna': { model: 'gpt-6-luna', effort: 'medium', max_output_chars: 64_000 } }, ceilings: { per_hour: 10, per_day: 10, concurrency: 2 }, max_body_bytes: 262_144, upstream: { connect_ms: 1000, request_ms: 1000 }, leak: {} as any };
const ev = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const text = '{"atoms":[]}';
const stream = ev('response.output_text.delta', { delta: text }) + ev('response.output_item.done', { item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
  + ev('response.completed', { response: { status: 'completed', model: 'gpt-6-luna-served', output: [], usage: { input_tokens: 900, output_tokens: 8 } } });
const upstreamBodies: unknown[] = [];
const handle = makeHandler(cfg, { callerSecret: Buffer.from(SECRET), limits: new Limits(join(dir, 'counters.json'), cfg.ceilings), accessToken: async () => 'stub', scan: async () => ({ clean: true }),
  upstream: async body => { upstreamBodies.push(body); return { status: 200, raw: Buffer.from(stream), charCapHit: false }; } });
const seen: Array<{ path: string; auth: boolean; body: any; status?: number; reply?: string }> = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => {
  const body = JSON.parse(await req.clone().text());
  const res = await handle(req); const reply = await res.clone().text();
  seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization') === `Bearer ${SECRET}`, body, status: res.status, reply: reply.slice(0, 300) });
  return res;
} });
process.env.LITELLM_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
process.env.LITELLM_API_KEY = SECRET;

const { chat, configureGatewayIfUninitialized } = await import('../../src/core/ai/gateway.ts');
const { atomsPrompt, ATOMS_RESPONSE_SCHEMA } = await import('../../src/core/cycle/extract-atoms.ts') as any;
configureGatewayIfUninitialized();
const prompt = atomsPrompt(true, 'session-check.part1.txt', 'user: we chose X over Y because Z.\nassistant: noted.');
let result: any, error: any;
try { result = await chat({ model: 'litellm:gpt-6-luna', ...prompt, maxTokens: 8192, responseSchema: ATOMS_RESPONSE_SCHEMA }); } catch (e) { error = String(e); }
server.stop(true);
console.log(JSON.stringify({
  requests_seen: seen.map(s => ({ path: s.path, auth_ok: s.auth, body_keys: Object.keys(s.body).sort(), max_tokens: s.body.max_tokens ?? s.body.max_completion_tokens, roles: s.body.messages?.map((m: any) => m.role), status: s.status, reply: s.status === 200 ? '(chat completion)' : s.reply })),
  upstream_body_keys: upstreamBodies.map(b => Object.keys(b as object).sort()),
  gbrain_result: result ? { text: result.text, model: result.model, responseModel: result.responseModel, finishReason: result.finishReason ?? result.stopReason, usage: result.usage } : null,
  error,
}, null, 1));
