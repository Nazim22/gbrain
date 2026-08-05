// S409 — reranker input bounding + per-query status (audit item 4).
// One oversized chunk must not capacity-fail the whole batch, and a
// failed/degraded call must be visible per query, never silent.

import { describe, expect, test } from 'bun:test';
import {
  applyReranker,
  MAX_RERANK_DOC_CHARS,
  type RerankCallStatus,
} from '../src/core/search/rerank.ts';
import type { SearchResult } from '../src/core/types.ts';

function res(slug: string, page_id: number, score: number, chunk = 'text'): SearchResult {
  return {
    slug, page_id, score,
    title: slug, type: 'note', chunk_text: chunk, chunk_source: 'compiled_truth',
    chunk_id: page_id, chunk_index: 0, stale: false,
  } as SearchResult;
}

const baseOpts = { enabled: true, topNIn: 30, topNOut: null };

describe('S409 reranker input bounding', () => {
  test('oversized documents are truncated to MAX_RERANK_DOC_CHARS before dispatch', async () => {
    const huge = 'x'.repeat(MAX_RERANK_DOC_CHARS * 5);
    let sentDocs: string[] = [];
    let status: RerankCallStatus | undefined;
    await applyReranker('q', [res('a', 1, 1.0, huge), res('b', 2, 0.9, 'small')], {
      ...baseOpts,
      onStatus: (s) => { status = s; },
      rerankerFn: async (input) => {
        sentDocs = [...input.documents];
        return input.documents.map((_, index) => ({ index, relevanceScore: 1 - index * 0.1 }));
      },
    });
    expect(sentDocs[0]!.length).toBe(MAX_RERANK_DOC_CHARS);
    expect(sentDocs[1]).toBe('small');
    expect(status?.status).toBe('applied');
    expect(status?.docs).toBe(2);
    expect(status?.truncated_docs).toBe(1);
  });

  test('a thrown reranker reports status failed and returns RRF order unchanged', async () => {
    let status: RerankCallStatus | undefined;
    const input = [res('a', 1, 1.0), res('b', 2, 0.9)];
    const out = await applyReranker('q', input, {
      ...baseOpts,
      onStatus: (s) => { status = s; },
      rerankerFn: async () => { throw new Error('capacity'); },
    });
    expect(out.map((r) => r.slug)).toEqual(['a', 'b']);
    expect(status?.status).toBe('failed');
  });

  test('a malformed (empty) reranker response reports failed, not applied', async () => {
    let status: RerankCallStatus | undefined;
    const out = await applyReranker('q', [res('a', 1, 1.0)], {
      ...baseOpts,
      onStatus: (s) => { status = s; },
      rerankerFn: async () => [],
    });
    expect(out[0]!.slug).toBe('a');
    expect(status?.status).toBe('failed');
    expect(status?.reason).toBe('unknown');
  });

  test('a throwing status sink never breaks search', async () => {
    const out = await applyReranker('q', [res('a', 1, 1.0)], {
      ...baseOpts,
      onStatus: () => { throw new Error('sink boom'); },
      rerankerFn: async (input) => input.documents.map((_, index) => ({ index, relevanceScore: 0.5 })),
    });
    expect(out[0]!.slug).toBe('a');
    expect(out[0]!.rerank_score).toBe(0.5);
  });
});
