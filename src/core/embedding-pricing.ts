/**
 * v0.32.7 CJK wave — embedding model pricing lookup table.
 *
 * Sibling to `anthropic-pricing.ts`. Used by `gbrain upgrade`'s post-upgrade
 * cost-estimate prompt so users with large brains see a dollar figure
 * before the chunker-version sweep re-embeds.
 *
 * Prices in USD per 1M tokens. Numbers as of 2026-05-11. Verify alongside
 * the Anthropic-pricing refresh cycle; drift here produces estimates
 * that mislead operators.
 *
 * Codex outside-voice C3 fold: non-OpenAI embedding providers (Voyage,
 * Hunyuan, Dashscope, etc.) return UNKNOWN_PROVIDER from `lookupPrice`
 * so the cost-estimate prompt can fall back to a "estimate unavailable
 * for <provider>; press Ctrl-C in 10s to abort" message rather than
 * fabricate numbers.
 */

export interface EmbeddingPricing {
  /** USD per 1M tokens (embedding cost; embeddings have no separate output rate). */
  pricePerMTok: number;
}

/**
 * `provider:model` keyed pricing. The colon-separated key matches
 * gateway model strings (e.g. 'openai:text-embedding-3-large').
 */
export const EMBEDDING_PRICING: Record<string, EmbeddingPricing> = {
  // OpenAI (https://openai.com/api/pricing/, verified 2026-05-11)
  'openai:text-embedding-3-large': { pricePerMTok: 0.13 },
  'openai:text-embedding-3-small': { pricePerMTok: 0.02 },
  // Legacy OpenAI ada (still common in older brains)
  'openai:text-embedding-ada-002': { pricePerMTok: 0.10 },
  // Voyage (https://www.voyageai.com/pricing)
  'voyage:voyage-3-large':         { pricePerMTok: 0.18 },
  'voyage:voyage-3':               { pricePerMTok: 0.06 },
  'voyage:voyage-4-large':         { pricePerMTok: 0.18 },
  // ZeroEntropy (https://zeroentropy.dev/pricing — zembed-1)
  'zeroentropyai:zembed-1':        { pricePerMTok: 0.05 },
  // ZeroEntropy reranker (docs/ai-providers/zeroentropy.md — $0.025/1M tokens).
  // Reused here (not a separate rerank table) because budget-tracker.ts's
  // rerank-kind lookup falls back to this same table for paid providers.
  'zeroentropyai:zerank-2':        { pricePerMTok: 0.025 },
  // Mistral (https://mistral.ai/pricing/api/, verified 2026-07-19)
  'mistral:mistral-embed':         { pricePerMTok: 0.10 },
  'mistral:mistral-embed-2312':    { pricePerMTok: 0.10 },
  // Perplexity (https://docs.perplexity.ai/getting-started/pricing, verified 2026-07-21)
  'perplexity:pplx-embed-v1-0.6b': { pricePerMTok: 0.004 },
  'perplexity:pplx-embed-v1-4b':   { pricePerMTok: 0.03 },
};

/**
 * S393 — providers that run on hardware you already own, so a USD spend cap
 * must never accrue against them.
 *
 * These are deliberately NOT entries in EMBEDDING_PRICING with `pricePerMTok: 0`:
 * that table is "what a vendor charges", and a zero there would read as a free
 * hosted tier rather than "there is no vendor". Keeping the concepts separate
 * means an unpriced HOSTED model still trips the unknown-price path (correct —
 * we cannot bound its cost), while a local one is bounded at zero by definition.
 *
 * Live failure this fixes: `embed-backfill` charged a flat $1/job proxy
 * regardless of provider, so 25 jobs against local `ollama:bge-m3` — actual
 * spend $0.00 — saturated the $25 default cap and silently set
 * `embed_skip_reason: spend_capped`. Embeddings then stopped landing while
 * every job reported success, which is the same disappear-quietly failure class
 * as the rest of S393.
 */
export const ZERO_COST_EMBEDDING_PROVIDERS: ReadonlySet<string> = new Set([
  'ollama',
  'llama-server',
  'llama-server-reranker',
  'local',
  'localai',
]);

/** True when the model runs on self-hosted hardware, i.e. costs no USD. */
export function isZeroCostEmbeddingProvider(modelString: string): boolean {
  if (!modelString) return false;
  const provider = (modelString.includes(':') ? modelString.split(':', 2)[0] : '')
    .trim().toLowerCase();
  return provider !== '' && ZERO_COST_EMBEDDING_PROVIDERS.has(provider);
}

export type PriceLookupResult =
  | { kind: 'known'; pricePerMTok: number; key: string }
  | { kind: 'unknown'; provider: string; model: string };

/**
 * Resolve a model string into a price-per-1M-tokens. Accepts both
 * `provider:model` and bare `model` forms (bare assumes openai).
 */
export function lookupEmbeddingPrice(modelString: string): PriceLookupResult {
  const [providerRaw, modelRaw] = modelString.includes(':')
    ? modelString.split(':', 2)
    : ['openai', modelString];
  const provider = providerRaw.trim().toLowerCase();
  const model = (modelRaw ?? '').trim();
  const key = `${provider}:${model}`;
  const hit = EMBEDDING_PRICING[key];
  if (hit) return { kind: 'known', pricePerMTok: hit.pricePerMTok, key };
  return { kind: 'unknown', provider, model };
}

/**
 * Estimate USD cost for embedding `charCount` characters. Uses
 * 3.5 chars/token as the OpenAI tiktoken-shaped approximation for English;
 * CJK-heavy brains will under-estimate by ~2x (one char ≈ one token), but
 * we'd rather under-estimate than spook users with a 10x worst-case figure.
 */
export function estimateCostFromChars(charCount: number, pricePerMTok: number): number {
  const tokens = Math.ceil(charCount / 3.5);
  return (tokens / 1_000_000) * pricePerMTok;
}
