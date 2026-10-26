/**
 * Chat Completions ⇄ ChatGPT-plan Responses contract (design /root/work/dream-s552-luna/DESIGN.md §2).
 * Nothing a caller asks for is silently dropped: a field the plan route cannot honour is refused with 400.
 */
/** max_output_chars is a CHARACTER bound on delivered text, never a token equivalent (the plan route has no output-token parameter). */
export type Route = { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; max_output_chars: number };
export type ChatRequest = { route: Route; alias: string; instructions: string; input: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens?: number };
export class ContractError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

const ALLOWED = new Set(['model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream']);

export function parseChatRequest(body: unknown, routes: Record<string, Route>): ChatRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ContractError(400, 'invalid_json_body');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!ALLOWED.has(k) && b[k] !== undefined && b[k] !== null) throw new ContractError(400, `unsupported:${k}`);
  if (b.stream !== undefined && b.stream !== false) throw new ContractError(400, 'unsupported:stream');
  if (typeof b.model !== 'string' || !Object.hasOwn(routes, b.model)) throw new ContractError(400, 'unknown_model');
  const maxRaw = b.max_completion_tokens ?? b.max_tokens;
  if (maxRaw !== undefined && maxRaw !== null && !(Number.isInteger(maxRaw) && (maxRaw as number) > 0)) throw new ContractError(400, 'invalid:max_tokens');
  if (!Array.isArray(b.messages) || b.messages.length === 0) throw new ContractError(400, 'invalid:messages');
  const system: string[] = [], input: ChatRequest['input'] = [];
  for (const m of b.messages as unknown[]) {
    if (!m || typeof m !== 'object') throw new ContractError(400, 'invalid:messages');
    const msg = m as Record<string, unknown>;
    for (const k of Object.keys(msg)) if (!['role', 'content', 'name'].includes(k) || (k === 'name' && msg.name !== undefined)) throw new ContractError(400, `unsupported:messages.${k}`);
    const content = textOf(msg.content);
    if (msg.role === 'system' || msg.role === 'developer') { if (input.length) throw new ContractError(400, 'unsupported:late_system_message'); system.push(content); }
    else if (msg.role === 'user' || msg.role === 'assistant') input.push({ role: msg.role, content });
    else throw new ContractError(400, `unsupported:role:${String(msg.role)}`);
  }
  if (!input.length || input[input.length - 1].role !== 'user') throw new ContractError(400, 'invalid:last_message_not_user');
  return { route: routes[b.model], alias: b.model, instructions: system.join('\n\n'), input, maxTokens: (maxRaw as number | undefined) ?? undefined };
}

function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every(p => p && typeof p === 'object' && (p as any).type === 'text' && typeof (p as any).text === 'string')) return c.map((p: any) => p.text).join('');
  throw new ContractError(400, 'unsupported:non_text_content');
}

/** The only upstream body shape the bridge ever sends (the reviewed eval `cloudBody`, generalised to multi-turn). */
export function responsesBody(r: ChatRequest) {
  return { model: r.route.model, instructions: r.instructions, input: r.input.map(m => ({ role: m.role, content: m.content })), stream: true, store: false, reasoning: { effort: r.route.effort } };
}

export type Outcome = { text: string; finish: 'stop' | 'length' | 'content_filter'; served?: string; usage?: { input_tokens?: number; output_tokens?: number } };

/** Token side of max_tokens: judged on the upstream's own output count; over it, the answer is delivered as `length` (truncated, not published by gbrain). */
export function applyMaxTokens(o: Outcome, maxTokens?: number): Outcome {
  if (maxTokens && o.finish === 'stop' && (o.usage?.output_tokens ?? 0) > maxTokens) return { ...o, finish: 'length' };
  return o;
}
export function chatCompletion(o: Outcome, alias: string, id: string) {
  return {
    id: `chatcmpl-${id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: o.served ?? alias,
    choices: [{ index: 0, message: { role: 'assistant', content: o.text }, finish_reason: o.finish }],
    usage: { prompt_tokens: o.usage?.input_tokens ?? 0, completion_tokens: o.usage?.output_tokens ?? 0, total_tokens: (o.usage?.input_tokens ?? 0) + (o.usage?.output_tokens ?? 0) },
  };
}
