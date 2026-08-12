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
const MAX_TEST_TITLE_CHARS = 256;

async function captureDocument(result: SearchResult): Promise<string> {
  let document = '';
  await applyReranker('q', [result], {
    ...baseOpts,
    rerankerFn: async (input) => {
      document = input.documents[0]!;
      return [{ index: 0, relevanceScore: 1 }];
    },
  });
  return document;
}

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
    expect(sentDocs[0]).toStartWith('x');
    expect(sentDocs[0]).toEndWith('\n\nTitle: a');
    expect(sentDocs[1]).toBe('small\n\nTitle: b');
    expect(status?.status).toBe('applied');
    expect(status?.docs).toBe(2);
    expect(status?.truncated_docs).toBe(1);
  });

  test.each([1999, 2000, 2001])(
    'keeps a matched body first and independently bounds a %i-character title',
    async (titleLength) => {
      const result = res('long-title', 1, 1.0, 'matched body');
      result.title = 't'.repeat(titleLength);

      const document = await captureDocument(result);

      expect(document).toBe(
        `matched body\n\nTitle: ${'t'.repeat(MAX_TEST_TITLE_CHARS)}`,
      );
      expect(document).not.toStartWith('\n');
      expect(document.length).toBeLessThanOrEqual(MAX_RERANK_DOC_CHARS);
    },
  );

  test('an empty body emits bounded title context without a separator prefix', async () => {
    const result = res('title-only', 1, 1.0, '');
    result.title = 't'.repeat(MAX_RERANK_DOC_CHARS + 1);

    const document = await captureDocument(result);

    expect(document).toBe(`Title: ${'t'.repeat(MAX_TEST_TITLE_CHARS)}`);
    expect(document).not.toStartWith('\n');
    expect(document.length).toBeLessThanOrEqual(MAX_RERANK_DOC_CHARS);
  });

  test('oversized bodies fill the exact document bound without losing bounded title identity', async () => {
    const result = res('long-title', 1, 1.0, 'b'.repeat(MAX_RERANK_DOC_CHARS * 2));
    result.title = 't'.repeat(MAX_RERANK_DOC_CHARS + 1);

    const document = await captureDocument(result);
    const titleSuffix = `\n\nTitle: ${'t'.repeat(MAX_TEST_TITLE_CHARS)}`;

    expect(document.length).toBe(MAX_RERANK_DOC_CHARS);
    expect(document).toStartWith('b');
    expect(document).not.toStartWith('\n\n');
    expect(document).toEndWith(titleSuffix);
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

  test('preserves only an incoming rank-1 exact-title winner', async () => {
    const named = res('named', 1, 1.0);
    named.title_match_boost = 1.25;
    const other = res('other', 2, 0.9);
    const rerankerFn = async () => [
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.1 },
    ];

    const protectedOut = await applyReranker('named', [named, other], {
      ...baseOpts,
      rerankerFn,
    });
    expect(protectedOut.map((r) => r.slug)).toEqual(['named', 'other']);
    expect(named.reranker_delta).toBe(0);
    expect(other.reranker_delta).toBe(0);

    const ordinary = res('ordinary', 3, 1.0);
    const ordinaryOut = await applyReranker('query', [ordinary, res('better', 4, 0.9)], {
      ...baseOpts,
      rerankerFn,
    });
    expect(ordinaryOut.map((r) => r.slug)).toEqual(['better', 'ordinary']);
  });

  test('protects an omitted rank-1 title match before topNOut truncation', async () => {
    const named = res('named', 1, 1.0);
    named.title_match_boost = 1.25;
    const other = res('other', 2, 0.9);

    const out = await applyReranker('named', [named, other], {
      ...baseOpts,
      topNOut: 1,
      rerankerFn: async () => [{ index: 1, relevanceScore: 0.9 }],
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(named);
    expect(named.reranker_delta).toBe(0);
    expect(named.rerank_score).toBeUndefined();
  });
});
