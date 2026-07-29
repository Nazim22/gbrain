import { describe, expect, test } from 'bun:test';
import {
  isZeroCostEmbeddingProvider,
  lookupEmbeddingPrice,
  ZERO_COST_EMBEDDING_PROVIDERS,
} from '../src/core/embedding-pricing.ts';

/**
 * S393 — a self-hosted embedder must not accrue against a USD spend cap.
 *
 * Live failure: `embed-backfill` charged a flat $1/job proxy regardless of
 * provider, so 25 jobs against local `ollama:bge-m3` — actual spend $0.00 —
 * saturated the $25 default cap and set `embed_skip_reason: spend_capped`.
 * Embeddings silently stopped landing while every job reported success.
 *
 * Fixed by teaching the aggregator which providers are free, NOT by disabling
 * the cap: the cap is the only thing bounding spend on a hosted embedder, and
 * removing a control to unblock a symptom is the wrong trade.
 */
describe('zero-cost embedding providers (S393)', () => {
  test('recognises the local providers actually in use here', () => {
    expect(isZeroCostEmbeddingProvider('ollama:bge-m3')).toBe(true);
    expect(isZeroCostEmbeddingProvider('llama-server-reranker:gte-reranker-modernbert-base')).toBe(true);
  });

  test('paid hosted providers are NOT zero-cost — the cap must still bind', () => {
    expect(isZeroCostEmbeddingProvider('openai:text-embedding-3-large')).toBe(false);
    expect(isZeroCostEmbeddingProvider('voyage:voyage-3-large')).toBe(false);
    expect(isZeroCostEmbeddingProvider('zeroentropyai:zembed-1')).toBe(false);
  });

  test('an UNKNOWN hosted provider is not treated as free', () => {
    // The dangerous direction: guessing free for something we cannot price
    // would silently uncap real spend. Unknown must stay capped.
    expect(isZeroCostEmbeddingProvider('somenewvendor:embed-v1')).toBe(false);
  });

  test('provider matching is case- and whitespace-insensitive', () => {
    expect(isZeroCostEmbeddingProvider('  OLLAMA:bge-m3 ')).toBe(true);
  });

  test('bare model strings (no provider) are not zero-cost', () => {
    // lookupEmbeddingPrice treats bare ids as openai:, so a bare id is hosted.
    expect(isZeroCostEmbeddingProvider('bge-m3')).toBe(false);
    expect(isZeroCostEmbeddingProvider('')).toBe(false);
  });

  test('zero-cost providers are deliberately absent from the PRICE table', () => {
    // Keeping the concepts separate matters: a 0 in EMBEDDING_PRICING would
    // read as "a vendor that charges nothing" rather than "there is no vendor",
    // and would mask a genuinely unpriced hosted model.
    for (const provider of ZERO_COST_EMBEDDING_PROVIDERS) {
      const res = lookupEmbeddingPrice(`${provider}:some-model`);
      expect(res.kind).toBe('unknown');
    }
  });
});
