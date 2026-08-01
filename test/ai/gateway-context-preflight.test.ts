// Pins the context preflight in gateway.chat().
//
// ProviderCapabilities.maxContext was documented as "drives the gateway's
// pre-flight context check; the loop refuses to send a prompt that exceeds
// this" — and nothing ever read it. A declared-but-unenforced limit is not a
// limit. Consequence (2026-08-01): a 35,345-token patterns prompt went to a
// 32,768-token local server, burned 3 retries, and killed the job with a
// provider-side error instead of one actionable message at the boundary.
//
// The preflight refuses only against a DECLARED ceiling, never the optimistic
// 128k default — so it cannot tighten behaviour for providers that stay silent.

import { describe, test, expect, afterEach } from 'bun:test';
import { chat, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { getDeclaredMaxContext } from '../../src/core/ai/capabilities.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';

const okResult = (model: string): ChatResult => ({
  text: 'ok',
  blocks: [{ type: 'text', text: 'ok' }],
  stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model,
  providerId: model.split(':')[0]!,
});

afterEach(() => {
  __setChatTransportForTests(null);
});

describe('getDeclaredMaxContext', () => {
  test('reports the local server ceiling instead of the 128k assumption', () => {
    // The bug: this returned nothing, so callers inherited 128_000.
    expect(getDeclaredMaxContext('llama-server:gemma-4-12b-qat')).toBe(32_768);
  });

  test('returns null — not a guess — when a recipe declares no ceiling', () => {
    // openrouter deliberately omits it (catalog spans 128K to 1M+).
    expect(getDeclaredMaxContext('openrouter:qwen/qwen3-235b-a22b-2507')).toBeNull();
    expect(getDeclaredMaxContext('nonsense-provider:whatever')).toBeNull();
  });
});

describe('gateway.chat context preflight', () => {
  test('refuses an oversized prompt at the boundary, naming both numbers', async () => {
    let reached = false;
    __setChatTransportForTests(async () => { reached = true; return okResult('llama-server:gemma-4-12b-qat'); });

    // ~4 chars/token heuristic: 40k tokens of input against a 32,768 ceiling.
    const huge = 'x '.repeat(80_000);
    let err: unknown;
    try {
      await chat({ model: 'llama-server:gemma-4-12b-qat', messages: [{ role: 'user', content: huge }], maxTokens: 500 });
    } catch (e) { err = e; }

    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as Error).message).toMatch(/32768|32,768/);
    // The point of a PREflight: the provider is never called.
    expect(reached).toBe(false);
  });

  test('a prompt that fits is sent normally', async () => {
    let reached = false;
    __setChatTransportForTests(async () => { reached = true; return okResult('llama-server:gemma-4-12b-qat'); });

    const res = await chat({
      model: 'llama-server:gemma-4-12b-qat',
      messages: [{ role: 'user', content: 'short question' }],
      maxTokens: 500,
    });

    expect(reached).toBe(true);
    expect(res.text).toBe('ok');
  });

  test('does NOT gate a provider that declares no ceiling', async () => {
    let reached = false;
    __setChatTransportForTests(async () => { reached = true; return okResult('openrouter:qwen/qwen3-235b-a22b-2507'); });

    const huge = 'x '.repeat(80_000);
    await chat({
      model: 'openrouter:qwen/qwen3-235b-a22b-2507',
      messages: [{ role: 'user', content: huge }],
      maxTokens: 500,
    });

    // Silent on assumption — only a declared limit is enforced.
    expect(reached).toBe(true);
  });

  test('maxTokens counts against the ceiling, not just the input', async () => {
    __setChatTransportForTests(async () => okResult('llama-server:gemma-4-12b-qat'));

    // Input alone fits; input + requested output does not.
    const mid = 'x '.repeat(50_000);   // ~25k tokens
    let err: unknown;
    try {
      await chat({ model: 'llama-server:gemma-4-12b-qat', messages: [{ role: 'user', content: mid }], maxTokens: 16_000 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AIConfigError);
  });
});
