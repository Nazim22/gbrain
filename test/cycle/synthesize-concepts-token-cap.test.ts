// synthesize_concepts resolves its narrative model at `tier: 'reasoning'` yet
// capped the call at a hardcoded 500 output tokens. On a thinking-by-default
// model, reasoning bills as output and counts against max_tokens, so the budget
// is spent before any answer text is emitted: hosted DeepSeek returns empty
// content with finish_reason "length" (→ 'empty model response' + a template
// stub narrative), while the native deepseek: recipe promotes the truncated
// reasoning_content into content (→ truncated chain-of-thought persisted as the
// concept narrative with synthesis_mode 'llm'). Both shapes are fixed by sizing
// the cap from the resolved model, the way think's maxOutputTokensFor does.
//
// Hermetic: PGLite + injected `_atoms` and `_chat`. No provider credentials and
// no network.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  runPhaseSynthesizeConcepts,
  resolveSynthMaxOutputTokens,
} from '../../src/core/cycle/synthesize-concepts.ts';
import { getProviderCapabilities } from '../../src/core/ai/capabilities.ts';
import { THINKING_MODEL_MAX_OUTPUT_TOKENS } from '../../src/core/ai/gateway.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

describe('resolveSynthMaxOutputTokens', () => {
  test('grants the gateway\'s verified thinking cap to a recipe-declared thinking-by-default model', () => {
    // Guard the premise: if the recipe drops the flag this fails here, loudly.
    expect(getProviderCapabilities('deepseek:deepseek-v4-flash').supportsThinking).toBe(true);
    // Not a local constant: a phase-private 8000 contradicted the gateway's
    // THINKING_MODEL_MAX_OUTPUT_TOKENS (DeepSeek v4 truncates at 8192-class
    // caps), so the reasoning budget was spent before any answer text.
    expect(THINKING_MODEL_MAX_OUTPUT_TOKENS).toBeGreaterThan(8192);
    expect(resolveSynthMaxOutputTokens('deepseek:deepseek-v4-flash')).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
  });

  test('grants the same cap to a name-matched Claude 5 model', () => {
    expect(resolveSynthMaxOutputTokens('anthropic:claude-sonnet-5')).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
  });

  test('Gemma 4 on llama-server gets a bounded, model-specific reasoning budget', () => {
    expect(resolveSynthMaxOutputTokens('llama-server:gemma-4-12b-qat')).toBe(1536);
    expect(resolveSynthMaxOutputTokens('llama-server:other-model')).toBe(500);
    expect(resolveSynthMaxOutputTokens('other-provider:gemma-4-12b-qat')).toBe(500);
  });

  test('keeps the 500 default for a non-thinking model', () => {
    expect(getProviderCapabilities('groq:qwen/qwen3.8-27b').supportsThinking).toBe(false);
    expect(resolveSynthMaxOutputTokens('groq:qwen/qwen3.8-27b')).toBe(500);
  });

  test('degrades to the default for an unknown provider instead of throwing', () => {
    expect(resolveSynthMaxOutputTokens('not-a-provider:nope')).toBe(500);
  });
});

describe('synthesize_concepts wires the cap into the narrative call', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60000);

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  /** Five atoms on one concept clears TIER_T2_MIN, which routes the group through chat(). */
  const t2Atoms = () =>
    Array.from({ length: 5 }, (_, i) => ({
      slug: `atoms/a${i}`,
      concept_refs: ['concepts/x'],
      body: `body ${i}`,
      title: `A${i}`,
    }));

  /** Records the `maxTokens` field of every chat() call the phase makes. */
  function capturingChat(seen: Array<number | undefined>): (o: ChatOpts) => Promise<ChatResult> {
    return async (o: ChatOpts) => {
      seen.push(o.maxTokens);
      const text = 'narrative text';
      return {
        text,
        blocks: [{ type: 'text', text }],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: o.model ?? 'unset',
        providerId: 'test',
      };
    };
  }

  test('a reasoning-exhausted 500-token Gemma call produces a narrative at the bounded cap', async () => {
    await engine.setConfig('models.dream.synthesize', 'llama-server:gemma-4-12b-qat');
    const caps: number[] = [];
    const result = await runPhaseSynthesizeConcepts(engine, {
      dryRun: true,
      _atoms: Array.from({ length: 10 }, (_, i) => ({
        slug: `atoms/a${i}`, concept_refs: ['concepts/x'], body: `body ${i}`, title: `A${i}`,
      })),
      _chat: async (o: ChatOpts) => {
        caps.push(o.maxTokens ?? 0);
        const text = (o.maxTokens ?? 0) >= 1536 ? 'A synthesized concept narrative.' : '';
        return {
          text,
          blocks: text ? [{ type: 'text', text }] : [],
          stopReason: text ? 'end' : 'length',
          usage: { input_tokens: 500, output_tokens: text ? 1003 : 500, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'llama-server:gemma-4-12b-qat', providerId: 'llama-server',
        };
      },
    });
    expect(caps).toEqual([1536]);
    expect((result.details as any).synthesis_mode_counts.llm).toBe(1);
    expect((result.details as any).synthesis_mode_counts.error_fallback).toBe(0);
  });

  test('a thinking-by-default models.dream.synthesize gets the gateway thinking cap; a non-thinking one keeps 500', async () => {
    await engine.setConfig('models.dream.synthesize', 'deepseek:deepseek-v4-flash');
    const thinking: Array<number | undefined> = [];
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: capturingChat(thinking) });
    expect(thinking.length).toBeGreaterThan(0);
    expect(new Set(thinking)).toEqual(new Set([THINKING_MODEL_MAX_OUTPUT_TOKENS]));

    // An explicit non-thinking model (not "unset"): resolveModel's unset path
    // falls through to GBRAIN_MODEL and a key-aware tier default, so the 500
    // pin would otherwise depend on which provider keys the runner has.
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
    const plain: Array<number | undefined> = [];
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: capturingChat(plain) });
    expect(plain.length).toBeGreaterThan(0);
    expect(new Set(plain)).toEqual(new Set([500]));
  });
});
