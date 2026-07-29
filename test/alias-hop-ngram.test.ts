// S393 — alias hop must fire when a query CONTAINS an alias, not only when it
// restates one.
//
// The live failure this encodes:
//   "where does cstoregenie run"                -> Access Map      1.0663 ✅
//   "where does cstoregenie run in production"  -> GCP-era memory  0.9566 ❌
// Two natural qualifying words moved the answer from the current canonical map
// to a superseded-era page. Separately, any query longer than
// MAX_ALIAS_QUERY_TOKENS was skipped outright, so a 10-token question never
// consulted aliases at all. Together these are the dominant cause of the
// retrieval fixture's `generic-to-named` family sitting at 43% Hit@1 (n=49).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { applyAliasHop } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedAlias(aliasNorm: string, slug: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, title, compiled_truth, type)
     VALUES ($1, 'default', $1, 'body', 'note')
     ON CONFLICT (source_id, slug) DO NOTHING`,
    [slug],
  );
  await engine.executeRaw(
    `INSERT INTO page_aliases (source_id, slug, alias_norm)
     VALUES ('default', $1, $2) ON CONFLICT DO NOTHING`,
    [slug, aliasNorm],
  );
}

function res(slug: string, score: number): SearchResult {
  return {
    slug, page_id: 1, score, title: slug, type: 'note',
    chunk_text: '', chunk_source: 'compiled_truth', chunk_id: 1,
    chunk_index: 0, stale: false, source_id: 'default',
  } as SearchResult;
}

describe('applyAliasHop — n-gram containment (S393)', () => {
  it('fires when the query CONTAINS the alias plus extra words', async () => {
    await seedAlias('where does cstoregenie run', 'projects/access-map');
    const out = await applyAliasHop(
      engine,
      [res('memory/gcp-era-note', 1.0)],
      'where does cstoregenie run in production',
      { sourceId: 'default' },
    );
    expect(out.some((r) => r.slug === 'projects/access-map')).toBe(true);
  });

  it('fires on queries LONGER than MAX_ALIAS_QUERY_TOKENS (previously skipped outright)', async () => {
    await seedAlias('lxc containers', 'areas/homelab-map');
    const out = await applyAliasHop(
      engine,
      [res('atoms/unrelated', 1.0)],
      'which lxc containers are running and what do they all do exactly',
      { sourceId: 'default' },
    );
    expect(out.some((r) => r.slug === 'areas/homelab-map')).toBe(true);
  });

  it('prefers the LONGEST matching alias — specificity beats the substring it contains', async () => {
    await seedAlias('park express', 'projects/park-express');
    await seedAlias('park express store id', 'projects/store-id');
    const out = await applyAliasHop(
      engine,
      [res('atoms/unrelated', 1.0)],
      'what is the park express store id again',
      { sourceId: 'default' },
    );
    // Widest n-gram wins, so the specific page is injected, not the generic one.
    expect(out.some((r) => r.slug === 'projects/store-id')).toBe(true);
  });

  it('does not fire on a single token — too collision-prone to inject on', async () => {
    await seedAlias('proxmox', 'areas/homelab-map');
    const before = [res('atoms/unrelated', 1.0)];
    const out = await applyAliasHop(engine, before, 'proxmox', { sourceId: 'default' });
    // Single-token queries still resolve exactly (unchanged contract), but a
    // lone token inside a longer sentence must not inject.
    const inSentence = await applyAliasHop(
      engine, [res('atoms/unrelated', 1.0)],
      'i was reading about proxmox yesterday evening', { sourceId: 'default' },
    );
    expect(out.length).toBeGreaterThanOrEqual(before.length);
    expect(inSentence.some((r) => r.slug === 'areas/homelab-map')).toBe(false);
  });

  it('no alias match leaves results untouched', async () => {
    await seedAlias('something else entirely', 'projects/other');
    const before = [res('atoms/unrelated', 1.0)];
    const out = await applyAliasHop(engine, before, 'a query with no known name', { sourceId: 'default' });
    expect(out).toHaveLength(before.length);
    expect(out[0].slug).toBe('atoms/unrelated');
  });

  it('empty query is a no-op', async () => {
    const before = [res('atoms/unrelated', 1.0)];
    const out = await applyAliasHop(engine, before, '', { sourceId: 'default' });
    expect(out).toHaveLength(1);
  });
});
