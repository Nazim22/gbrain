import { describe, expect, test } from 'bun:test';
import {
  applySupersededDemote,
  applySupersededDemotePostRerank,
  SUPERSEDED_DEMOTE_FACTOR,
} from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';

/**
 * S393 — superseded pages must not outrank the pages that replaced them.
 *
 * The live failure this encodes: the retired "Dae is reviewer-only" policy
 * scored 1.007 while the S389 rule that reversed it scored 0.920, so asking
 * "can Dae build on CStoreGenie?" returned the dead answer first. Supersession
 * carried no ranking signal, and because `effective_date` falls back to
 * `updated_at`, adding a supersede banner made the retired page look FRESHER.
 */

function res(slug: string, page_id: number, score: number): SearchResult {
  return {
    slug, page_id, score,
    title: slug, type: 'note', chunk_text: '', chunk_source: 'compiled_truth',
    chunk_id: page_id, chunk_index: 0, stale: false,
  } as SearchResult;
}

describe('applySupersededDemote', () => {
  test('reorders the real S393 case: retired policy no longer beats its replacement', () => {
    const retired = res('memory/feedback_pingu_builds_dae_reviews_per_project_s387', 1, 1.007);
    const current = res('memory/feedback_dae_builds_pingu_is_review_authority_s389', 2, 0.920);
    const results = [retired, current];

    applySupersededDemote(results, new Set([1]));
    results.sort((a, b) => b.score - a.score);

    expect(results[0].slug).toContain('s389');
    expect(retired.score).toBeLessThan(current.score);
  });

  test('demote factor is applied exactly once and stamped for --explain', () => {
    const r = res('retired', 7, 1.0);
    applySupersededDemote([r], new Set([7]));
    expect(r.score).toBeCloseTo(SUPERSEDED_DEMOTE_FACTOR, 10);
    expect(r.superseded_demote).toBe(SUPERSEDED_DEMOTE_FACTOR);
  });

  test('leaves non-superseded results untouched and unstamped', () => {
    const r = res('live', 3, 0.8);
    applySupersededDemote([r], new Set([99]));
    expect(r.score).toBe(0.8);
    expect(r.superseded_demote).toBeUndefined();
  });

  test('empty superseded set is a no-op (no wasted pass)', () => {
    const r = res('live', 4, 0.5);
    applySupersededDemote([r], new Set());
    expect(r.score).toBe(0.5);
  });

  test('NaN scores are skipped rather than propagated', () => {
    const r = res('broken', 5, NaN);
    applySupersededDemote([r], new Set([5]));
    expect(Number.isNaN(r.score)).toBe(true);
    expect(r.superseded_demote).toBeUndefined();
  });

  test('demotes low-scoring results too — NOT floor-gated', () => {
    // The other metadata stages skip weak results because boosting noise is
    // pointless. A demote is the opposite: the weak-but-winning superseded
    // page is exactly the case that must be caught.
    const weak = res('retired-weak', 6, 0.01);
    applySupersededDemote([weak], new Set([6]));
    expect(weak.score).toBeCloseTo(0.01 * SUPERSEDED_DEMOTE_FACTOR, 10);
  });

  test('factor is a demote, not an exclude — page stays retrievable', () => {
    // "why was X replaced" legitimately wants the retired page. Hard excludes
    // live in the archive/ prefix policy, not here.
    expect(SUPERSEDED_DEMOTE_FACTOR).toBeGreaterThan(0);
    expect(SUPERSEDED_DEMOTE_FACTOR).toBeLessThan(1);
  });
});

/**
 * S395 — the demote must survive the RERANKER. The cross-encoder re-orders
 * the head purely by its own relevanceScore; without a post-rerank pass, a
 * retired page that survives into the rerank window is promoted straight
 * back (measured: the S387 pages re-took ranks 1–2 with reranker_delta +16
 * despite `superseded_demote: 0.45` stamped on them).
 */
function rr(slug: string, page_id: number, rerank_score?: number): SearchResult {
  const r = res(slug, page_id, 0.5);
  if (rerank_score !== undefined) r.rerank_score = rerank_score;
  return r;
}

describe('applySupersededDemotePostRerank', () => {
  test('reorders the real S395 case: reranker-promoted retired page loses to its replacement', () => {
    const retired = rr('memory/feedback_pingu_builds_dae_reviews_per_project_s387', 1, 2.34);
    const current = rr('memory/feedback_dae_builds_pingu_is_review_authority_s389', 2, 2.1);
    const results = [retired, current];

    applySupersededDemotePostRerank(results, new Set([1]));

    expect(results[0].slug).toContain('s389');
    expect(retired.rerank_score).toBeCloseTo(2.34 * SUPERSEDED_DEMOTE_FACTOR, 10);
    expect(retired.superseded_demote).toBe(SUPERSEDED_DEMOTE_FACTOR);
  });

  test('only the reranked head is touched — un-reranked tail keeps order and scores', () => {
    const headLive = rr('live-head', 1, 3.0);
    const headRetired = rr('retired-head', 2, 2.5);
    const tailRetired = rr('retired-tail', 3); // no rerank_score
    const results = [headLive, headRetired, tailRetired];

    applySupersededDemotePostRerank(results, new Set([2, 3]));

    expect(results[2].slug).toBe('retired-tail');
    expect(results[2].rerank_score).toBeUndefined();
    // tail item is NOT stamped by this stage (pre-rerank stage already ran on it)
    expect(results[2].superseded_demote).toBeUndefined();
    expect(results[1].slug).toBe('retired-head');
  });

  test('no superseded pages in head → order untouched (no wasted sort)', () => {
    const a = rr('a', 1, 2.0);
    const b = rr('b', 2, 1.0);
    const results = [a, b];
    applySupersededDemotePostRerank(results, new Set([99]));
    expect(results[0].slug).toBe('a');
    expect(a.rerank_score).toBe(2.0);
  });

  test('no reranked head at all (reranker failed / disabled) → no-op', () => {
    const a = rr('a', 1);
    const results = [a];
    applySupersededDemotePostRerank(results, new Set([1]));
    expect(a.rerank_score).toBeUndefined();
    expect(a.superseded_demote).toBeUndefined();
  });
});
