/**
 * S551: `chat({ thinking: 'off' })` on a llama-server route sends
 * `chat_template_kwargs: { enable_thinking: false }` in the request body (the
 * openai-compatible provider spreads the `llama-server` options namespace into
 * the body), keeps the requested output cap, and leaves calls without the
 * switch untouched. Drives the real gateway against a local stub server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chat, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { thinkingOffControl } from '../../src/core/ai/thinking-off.ts';

let server: ReturnType<typeof Bun.serve>;
let bodies: any[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.json();
      bodies.push(body);
      return Response.json({
        id: 'chatcmpl_stub', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});
afterAll(() => { server.stop(true); resetGateway(); });
beforeEach(() => {
  bodies = [];
  resetGateway();
  configureGateway({ chat_model: 'llama-server:local-model', env: {}, base_urls: { 'llama-server': `http://127.0.0.1:${server.port}/v1` } });
});

describe("llama-server thinking-off (S551)", () => {
  test('the capability table has a full off switch for llama-server', () => {
    expect(thinkingOffControl('llama-server:local-model')).toEqual({
      set: { namespace: 'llama-server', options: { chat_template_kwargs: { enable_thinking: false } } },
      disables: true,
    });
  });

  test("thinking: 'off' sends chat_template_kwargs.enable_thinking=false and keeps the requested cap", async () => {
    await chat({ model: 'llama-server:local-model', messages: [{ role: 'user', content: 'x' }], maxTokens: 2000, thinking: 'off' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0].max_tokens).toBe(2000);
  });

  test('without the switch the request body carries no template kwargs', async () => {
    await chat({ model: 'llama-server:local-model', messages: [{ role: 'user', content: 'x' }], maxTokens: 2000 });
    expect(bodies).toHaveLength(1);
    expect('chat_template_kwargs' in bodies[0]).toBe(false);
  });
});
