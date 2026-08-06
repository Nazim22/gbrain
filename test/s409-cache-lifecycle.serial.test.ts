/**
 * S409 review fixes (Dae HOLD → follow-ups) — semantic-cache lifecycle
 * revalidation + reranker-status propagation through the cached wrapper.
 *
 * P0 pin: cache a current page → supersede it → the SAME query must not
 * serve the cached row as current rank-1. The cache-read path now
 * revalidates lifecycle and falls through to a fresh search (whose ranking
 * demotes and whose stamps mark the page stale).
 *
 * P1 pin: hybridSearchCached's rebuilt meta was dropping
 * HybridSearchMeta.reranker — miss must carry the inner status; hit must
 * report 'bypassed' (no reranker ran), never pretend one did.
 *
 * Serial: mock.module + gateway/global-env mutation (isolation guard R2).
 * Harness copied from hybrid-cached-hit-budget-meta.serial.test.ts.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';

function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async () => fixedEmbedding(),
}));

const { hybridSearchCached, awaitPendingSearchCacheWrites } =
  await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-s409-cache-lifecycle-'));
  process.env.GBRAIN_HOME = tmpHome;
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const truth = 'Quantum widget deployment guide. ' + 'x'.repeat(400);
  await engine.putPage('quantum-widget-guide', {
    type: 'note', title: 'Quantum Widget Guide', compiled_truth: truth,
  });
  await engine.upsertChunks('quantum-widget-guide', [
    { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
  ]);
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const fakeReranker = async (input: { documents: string[] }) =>
  input.documents.map((_, index) => ({ index, relevanceScore: 1 - index * 0.01 }));

describe('S409 cache-hit lifecycle revalidation', () => {
  test('supersession after cache write is not served as current from cache', async () => {
    // 1. Miss → cache write, page is current.
    let missMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const miss = await hybridSearchCached(engine, 'quantum widget deployment', {
      limit: 5,
      reranker: { enabled: true, topNIn: 5, topNOut: null, rerankerFn: fakeReranker },
      onMeta: (m) => { missMeta = m; },
    });
    expect(miss.length).toBeGreaterThan(0);
    expect(missMeta?.cache?.status).toBe('miss');
    // P1 pin: the cached wrapper propagates the inner reranker status on miss.
    expect(missMeta?.reranker?.status).toBe('applied');

    await awaitPendingSearchCacheWrites();

    // 2. Sanity: identical query now HITS, and the hit reports 'bypassed'.
    let hitMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const hit = await hybridSearchCached(engine, 'quantum widget deployment', {
      limit: 5,
      reranker: { enabled: true, topNIn: 5, topNOut: null, rerankerFn: fakeReranker },
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    expect(hit[0]?.slug).toBe('quantum-widget-guide');
    expect(hitMeta?.reranker?.status).toBe('bypassed');

    // 3. Supersede the page AFTER the cache write and point at a typed
    // successor. The normalized columns are authoritative; frontmatter stays
    // only as the import source/back-compat record.
    const successor = await engine.putPage('quantum-widget-guide-v2', {
      type: 'note', title: 'Quantum Widget Guide v2',
      compiled_truth: 'Current quantum widget deployment guide.',
      frontmatter: { status: 'current' },
      lifecycle_status: 'current',
    });
    await engine.upsertChunks('quantum-widget-guide-v2', [
      { chunk_index: 0, chunk_text: 'Current quantum widget deployment guide.', chunk_source: 'compiled_truth' },
    ]);
    await engine.executeRaw(
      `UPDATE pages
          SET frontmatter = frontmatter || '{"status":"superseded","superseded_by":"quantum-widget-guide-v2"}'::text::jsonb,
              lifecycle_status = 'superseded',
              superseded_by_page_id = $1
        WHERE slug = 'quantum-widget-guide'`,
      [successor.id],
    );

    // 4. Same query again: the poisoned cache row must NOT be served as
    // current. The mandatory cache-read policy resolves it to the live
    // successor and never returns the retired row.
    let afterMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const after = await hybridSearchCached(engine, 'quantum widget deployment', {
      limit: 5,
      reranker: { enabled: true, topNIn: 5, topNOut: null, rerankerFn: fakeReranker },
      onMeta: (m) => { afterMeta = m; },
    });
    expect(afterMeta?.cache?.status).not.toBe('hit');
    expect(after.some((r) => r.slug === 'quantum-widget-guide')).toBe(false);
    expect(after[0]).toMatchObject({
      slug: 'quantum-widget-guide-v2',
      page_id: successor.id,
      lifecycle_status: 'current',
    });
  }, 30_000);
});
