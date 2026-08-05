// S409 — current-truth containment (the gbrain-audit adoption wave).
//
// The live failure this encodes: a current-state CStoreGenie query ranked a
// month-stale overview page #1 with `stale: false` and a 1.74× recency boost
// earned by SYNC CHURN (effective_date_source='fallback'), while the page's
// own named successor ranked below it — and alias promotion, running after
// both supersession demotes, could hoist a retired page straight back to #1.
//
// Four contracts pinned here:
//   1. getSupersededPageIds demotes the WIDENED lifecycle set (status
//      superseded/deprecated/retired, superseded_by, freshness:stale).
//   2. getEffectiveDates emits NO date for fallback-sourced pages, so
//      applyRecencyBoost leaves them recency-neutral.
//   3. applyAliasHop refuses to promote a lifecycle-demoted page: with a
//      live successor it redirects the hop; without one it leaves the page
//      to its already-demoted organic rank.
//   4. stampPageDates stamps lifecycle_status / superseded_by / effective
//      date+source and forces stale=true on any non-current page.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  applyAliasHop,
  applyRecencyBoost,
  isLifecycleDemoted,
  stampPageDates,
  successorSlugFrom,
} from '../src/core/search/hybrid.ts';
import { DEFAULT_FALLBACK } from '../src/core/search/recency-decay.ts';
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

async function insertPage(
  slug: string,
  frontmatter: Record<string, unknown>,
  opts?: { effectiveDate?: string; effectiveDateSource?: string },
): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter,
                        effective_date, effective_date_source)
     VALUES ('default', $1, 'note', $1, 'body of ' || $1, $2::text::jsonb, $3, $4)
     RETURNING id`,
    [slug, JSON.stringify(frontmatter), opts?.effectiveDate ?? null, opts?.effectiveDateSource ?? null],
  );
  return Number(rows[0].id);
}

function res(slug: string, page_id: number, score: number): SearchResult {
  return {
    slug, page_id, score,
    title: slug, type: 'note', chunk_text: '', chunk_source: 'compiled_truth',
    chunk_id: page_id, chunk_index: 0, stale: false, source_id: 'default',
  } as SearchResult;
}

describe('getSupersededPageIds — widened lifecycle set', () => {
  it('demotes all four lifecycle signals, not just exact status:superseded', async () => {
    const ids = {
      superseded: await insertPage('p/superseded', { status: 'Superseded' }),
      deprecated: await insertPage('p/deprecated', { status: 'deprecated' }),
      retired: await insertPage('p/retired', { status: 'RETIRED' }),
      pointer: await insertPage('p/pointer', { superseded_by: '[[p/current]]' }),
      stale: await insertPage('p/stale', { freshness: 'stale' }),
      current: await insertPage('p/current', { status: 'active' }),
      bare: await insertPage('p/bare', {}),
    };
    const demoted = await engine.getSupersededPageIds(Object.values(ids));
    expect(demoted.has(ids.superseded)).toBe(true);
    expect(demoted.has(ids.deprecated)).toBe(true);
    expect(demoted.has(ids.retired)).toBe(true);
    expect(demoted.has(ids.pointer)).toBe(true);
    expect(demoted.has(ids.stale)).toBe(true);
    expect(demoted.has(ids.current)).toBe(false);
    expect(demoted.has(ids.bare)).toBe(false);
  });
});

describe('getEffectiveDates — fallback dates are recency-neutral', () => {
  it('emits no entry for a fallback-sourced page, a real entry otherwise', async () => {
    await insertPage('p/authored', {}, { effectiveDate: '2026-08-01', effectiveDateSource: 'frontmatter' });
    await insertPage('p/synced', {}, { effectiveDate: '2026-08-04', effectiveDateSource: 'fallback' });
    const dates = await engine.getEffectiveDates([
      { slug: 'p/authored', source_id: 'default' },
      { slug: 'p/synced', source_id: 'default' },
    ]);
    expect(dates.has('default::p/authored')).toBe(true);
    expect(dates.has('default::p/synced')).toBe(false);
  });

  it('a fallback-dated page therefore gets NO recency boost', async () => {
    await insertPage('p/synced2', {}, { effectiveDate: '2026-08-04', effectiveDateSource: 'fallback' });
    const dates = await engine.getEffectiveDates([{ slug: 'p/synced2', source_id: 'default' }]);
    const r = res('p/synced2', 999, 1.0);
    applyRecencyBoost([r], dates, 'on', {}, DEFAULT_FALLBACK, Date.now());
    expect(r.score).toBe(1.0);
    expect(r.recency_boost).toBeUndefined();
  });
});

describe('lifecycle helpers', () => {
  it('isLifecycleDemoted matches the SQL predicate', () => {
    expect(isLifecycleDemoted({ status: 'Superseded' })).toBe(true);
    expect(isLifecycleDemoted({ status: 'deprecated' })).toBe(true);
    expect(isLifecycleDemoted({ status: 'retired' })).toBe(true);
    expect(isLifecycleDemoted({ superseded_by: '[[x]]' })).toBe(true);
    expect(isLifecycleDemoted({ freshness: 'STALE' })).toBe(true);
    expect(isLifecycleDemoted({ status: 'active' })).toBe(false);
    expect(isLifecycleDemoted({})).toBe(false);
    expect(isLifecycleDemoted(null)).toBe(false);
    expect(isLifecycleDemoted({ superseded_by: '   ' })).toBe(false);
  });

  it('successorSlugFrom strips wikilink brackets', () => {
    expect(successorSlugFrom({ superseded_by: '[[p/new]]' })).toBe('p/new');
    expect(successorSlugFrom({ superseded_by: 'p/new' })).toBe('p/new');
    expect(successorSlugFrom({ superseded_by: '' })).toBeUndefined();
    expect(successorSlugFrom({})).toBeUndefined();
  });
});

describe('applyAliasHop — lifecycle gate', () => {
  async function withAlias(alias: string, canonical: string) {
    await engine.setPageAliases(canonical, 'default', [alias]);
  }

  it('redirects an alias pointing at a superseded page to its live successor', async () => {
    await insertPage('p/old-map', { status: 'superseded', superseded_by: '[[p/new-map]]' });
    await insertPage('p/new-map', { status: 'active' });
    await withAlias('access map', 'p/old-map');

    const organic = [res('p/unrelated', 1, 0.9)];
    const out = await applyAliasHop(engine, organic, 'access map', {});

    const slugs = out.map((r) => r.slug);
    expect(slugs).toContain('p/new-map');
    expect(slugs).not.toContain('p/old-map');
    expect(out[0].slug).toBe('p/new-map'); // injected at top-of-organic
  });

  it('refuses to promote a demoted page with no live successor', async () => {
    await insertPage('p/dead-end', { status: 'retired' });
    await withAlias('dead thing', 'p/dead-end');

    const organic = [res('p/unrelated', 1, 0.9)];
    const out = await applyAliasHop(engine, organic, 'dead thing', {});
    expect(out.map((r) => r.slug)).not.toContain('p/dead-end');
  });

  it('does not re-promote a demoted page already present in results', async () => {
    const deadId = await insertPage('p/dead-present', { freshness: 'stale' });
    await withAlias('present thing', 'p/dead-present');

    // Organic rank: demoted page below a current page (the demote already fired).
    const organic = [res('p/current-winner', 1, 0.9), res('p/dead-present', deadId, 0.4)];
    const out = await applyAliasHop(engine, organic, 'present thing', {});

    expect(out[0].slug).toBe('p/current-winner');
    const dead = out.find((r) => r.slug === 'p/dead-present');
    expect(dead?.score).toBe(0.4); // untouched — no alias promotion
    expect(dead?.alias_hit).toBeUndefined();
  });

  it('still promotes a current page normally (no behavior change)', async () => {
    await insertPage('p/live-target', { status: 'active' });
    await withAlias('live thing', 'p/live-target');

    const organic = [res('p/unrelated', 1, 0.9)];
    const out = await applyAliasHop(engine, organic, 'live thing', {});
    expect(out[0].slug).toBe('p/live-target');
    expect(out[0].alias_hit).toBe(true);
  });
});

describe('stampPageDates — current-truth metadata', () => {
  it('stamps lifecycle, successor, effective date+source, and forces stale=true', async () => {
    const oldId = await insertPage(
      'p/stamp-old',
      { status: 'superseded', superseded_by: '[[p/stamp-new]]' },
      { effectiveDate: '2026-06-27', effectiveDateSource: 'frontmatter' },
    );
    const syncedId = await insertPage(
      'p/stamp-synced',
      {},
      { effectiveDate: '2026-08-04', effectiveDateSource: 'fallback' },
    );

    const results = [res('p/stamp-old', oldId, 1.0), res('p/stamp-synced', syncedId, 0.8)];
    await stampPageDates(engine, results);

    const old = results[0];
    expect(old.lifecycle_status).toBe('superseded');
    expect(old.superseded_by).toBe('p/stamp-new');
    expect(old.effective_date).toBe('2026-06-27');
    expect(old.effective_date_source).toBe('frontmatter');
    expect(old.stale).toBe(true); // never stale:false for a superseded page

    const synced = results[1];
    expect(synced.lifecycle_status).toBe('current');
    expect(synced.effective_date_source).toBe('fallback');
    expect(synced.stale).toBe(false); // current page: SQL verdict stands
  });

  it('never clears a SQL-computed stale=true on a current page', async () => {
    const id = await insertPage('p/sql-stale', {});
    const r = { ...res('p/sql-stale', id, 1.0), stale: true };
    await stampPageDates(engine, [r]);
    expect(r.stale).toBe(true);
  });
});
