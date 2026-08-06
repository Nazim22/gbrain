// S409 structural lifecycle contract — v127 normalization + retrieval policy.
// Serial because resetGateway mutates process-global gateway configuration.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import * as hybrid from '../src/core/search/hybrid.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  resetGateway();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const page = (title: string, body: string, frontmatter = '') => `---
title: ${title}
type: note
${frontmatter}---
# ${title}

${body}
`;

function result(slug: string, id: number, score = 1): SearchResult {
  return {
    slug,
    page_id: id,
    title: slug,
    type: 'note',
    chunk_text: `chunk for ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: id,
    chunk_index: 0,
    score,
    stale: false,
    source_id: 'default',
  };
}

async function importPage(slug: string, title: string, body: string, frontmatter = '', sourceId = 'default') {
  const receipt = await importFromContent(engine, slug, page(title, body, frontmatter), {
    noEmbed: true,
    sourceId,
    forceRechunk: true,
  });
  expect(receipt.status).toBe('imported');
  const imported = await engine.getPage(slug, { sourceId });
  expect(imported).not.toBeNull();
  return imported!;
}

describe('migration v127 — normalized lifecycle schema and backfill', () => {
  test('registry contains the typed lifecycle migration and source-scoped safe backfill', () => {
    const migration = MIGRATIONS.find((m) => m.version === 127);
    expect(migration?.name).toBe('page_lifecycle_contract');
    expect(migration?.idempotent).toBe(true);
    const sql = migration?.sql ?? '';
    for (const column of [
      'lifecycle_status',
      'superseded_by_page_id',
      'canonical_page_id',
      'valid_from',
      'valid_until',
      'authored_at',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/CHECK[\s\S]*current[\s\S]*superseded[\s\S]*historical[\s\S]*draft/i);
    expect(sql).toMatch(/REFERENCES\s+pages\s*\(id\)/i);
    expect(sql).toMatch(/target\.source_id\s*=\s*p\.source_id/i);
    expect(sql).toMatch(/CASE[\s\S]*historical[\s\S]*deprecated[\s\S]*retired/i);
  });

  test('fresh schema exposes constrained lifecycle columns', async () => {
    const columns = await engine.executeRaw<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'pages'
          AND column_name IN ('lifecycle_status','superseded_by_page_id','canonical_page_id','valid_from','valid_until','authored_at')
        ORDER BY column_name`,
    );
    expect(columns.map((r) => r.column_name)).toEqual([
      'authored_at',
      'canonical_page_id',
      'lifecycle_status',
      'superseded_by_page_id',
      'valid_from',
      'valid_until',
    ]);
    expect(columns.find((r) => r.column_name === 'lifecycle_status')?.is_nullable).toBe('NO');
  });
});

describe('import + engine lifecycle parity', () => {
  test('predecessor-before-successor resolves both outgoing relations when target arrives', async () => {
    const old = await importPage(
      'docs/old',
      'Old',
      'Legacy quasar widget architecture.',
      `status: retired\nsuperseded_by: "[[docs/new]]"\ncanonical_page: "[[docs/new]]"\nvalid_from: "2024-01-02"\nvalid_until: "2025-02-03"\nauthored_at: "2023-12-31T12:34:56Z"\n`,
    );
    expect(old.lifecycle_status).toBe('superseded');
    expect(old.superseded_by_page_id).toBeNull();

    const successor = await importPage('docs/new', 'New', 'Current quasar widget architecture.', 'status: current\n');
    const reread = await engine.getPage('docs/old', { sourceId: 'default' });

    expect(reread?.lifecycle_status).toBe('superseded');
    expect(reread?.superseded_by_page_id).toBe(successor.id);
    expect(reread?.canonical_page_id).toBe(successor.id);
    expect(reread?.valid_from?.toISOString().slice(0, 10)).toBe('2024-01-02');
    expect(reread?.valid_until?.toISOString().slice(0, 10)).toBe('2025-02-03');
    expect(reread?.authored_at?.toISOString()).toBe('2023-12-31T12:34:56.000Z');

    const lifecycleRows = await (engine as any).getPageLifecycles([old.id]);
    expect(lifecycleRows.get(old.id)).toMatchObject({
      page_id: old.id,
      lifecycle_status: 'superseded',
      superseded_by_page_id: successor.id,
      superseded_by: 'docs/new',
      canonical_page_id: successor.id,
      canonical_slug: 'docs/new',
    });
  });

  test('relations are same-source and malformed dates become null', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb)`,
    );
    const otherTarget = await importPage('docs/new', 'Other New', 'Other source target.', '', 'other');
    const old = await importPage(
      'docs/old-bad-date',
      'Old Bad Date',
      'Legacy bad-date quasar widget.',
      `superseded_by: "[[docs/new]]"\nvalid_from: "not-a-date"\nvalid_until: "2025-99-99"\nauthored_at: "yesterday-ish"\n`,
    );
    const row = await engine.getPage('docs/old-bad-date', { sourceId: 'default' });
    expect(row?.lifecycle_status).toBe('superseded');
    expect(row?.superseded_by_page_id).toBeNull();
    expect(row?.superseded_by_page_id).not.toBe(otherTarget.id);
    expect(row?.valid_from).toBeNull();
    expect(row?.valid_until).toBeNull();
    expect(row?.authored_at).toBeNull();
    expect(old.source_id).toBe('default');
  });
});

describe('mandatory post-alias lifecycle policy', () => {
  test('current-state redirects superseded result; historical intent keeps it labeled', async () => {
    const successor = await importPage('docs/current-truth', 'Current Truth', 'Current truth body.', 'status: current\n');
    const old = await importPage(
      'docs/retired-truth',
      'Retired Truth',
      'Legacy truth body.',
      `status: superseded\nsuperseded_by: "[[docs/current-truth]]"\n`,
    );
    const apply = (hybrid as any).applyLifecyclePolicy;
    expect(typeof apply).toBe('function');

    const current = await apply(engine, [result(old.slug, old.id)], 'what is the truth now');
    expect(current.map((r: SearchResult) => r.slug)).toEqual(['docs/current-truth']);
    expect(current[0]).toMatchObject({
      page_id: successor.id,
      lifecycle_status: 'current',
    });

    const historical = await apply(engine, [result(old.slug, old.id)], 'history of the truth');
    expect(historical.map((r: SearchResult) => r.slug)).toEqual(['docs/retired-truth']);
    expect(historical[0]).toMatchObject({
      lifecycle_status: 'superseded',
      superseded_by_page_id: successor.id,
      superseded_by: 'docs/current-truth',
      stale: true,
    });
  });

  test('column-backed policy catches a retired alias after frontmatter heuristics are unavailable', async () => {
    const successor = await importPage('docs/live-alias', 'Live Alias', 'Current alias destination.', 'status: current\n');
    const old = await importPage(
      'docs/dead-alias',
      'Dead Alias',
      'Retired alias destination.',
      `status: superseded\nsuperseded_by: "[[docs/live-alias]]"\naliases: ["quasar map"]\n`,
    );
    // Prove retrieval consumes normalized columns, not rank-time frontmatter heuristics.
    await engine.executeRaw(`UPDATE pages SET frontmatter = '{}'::jsonb WHERE id = $1`, [old.id]);

    const hopped = await hybrid.applyAliasHop(engine, [], 'quasar map', {});
    expect(hopped[0]?.slug).toBe('docs/dead-alias');
    const filtered = await (hybrid as any).applyLifecyclePolicy(engine, hopped, 'quasar map');
    expect(filtered.map((r: SearchResult) => r.slug)).toEqual(['docs/live-alias']);
    expect(filtered[0]?.page_id).toBe(successor.id);
  });

  test('explicit historical intent is narrow: latest remains current-state', () => {
    const isHistorical = (hybrid as any).isHistoricalLifecycleIntent;
    expect(typeof isHistorical).toBe('function');
    expect(isHistorical('history of the quasar map')).toBe(true);
    expect(isHistorical('timeline for the quasar map')).toBe(true);
    expect(isHistorical('what was true as of 2024')).toBe(true);
    expect(isHistorical('latest quasar map')).toBe(false);
    expect(isHistorical('what is the quasar map right now')).toBe(false);
  });
});

describe('all fresh search return paths enforce lifecycle', () => {
  test('no-embedding keyword path redirects an organic retired hit', async () => {
    resetGateway();
    await importPage('docs/quasar-current', 'Quasar Current', 'Current destination without the legacy phrase.', 'status: current\n');
    await importPage(
      'docs/quasar-retired',
      'Quasar Retired',
      'Legacy quasar widget architecture unique phrase.',
      `status: superseded\nsuperseded_by: "[[docs/quasar-current]]"\n`,
    );

    const rows = await hybrid.hybridSearch(engine, 'legacy quasar widget architecture unique phrase', {
      limit: 10,
      expansion: false,
      useCache: false,
      graph_signals: false,
      relationalRetrieval: false,
    });
    expect(rows.some((r) => r.slug === 'docs/quasar-retired')).toBe(false);
    expect(rows[0]?.slug).toBe('docs/quasar-current');
    expect(rows[0]?.lifecycle_status).toBe('current');
  });

  test('historical keyword path may return the retired hit with successor fields', async () => {
    resetGateway();
    const successor = await importPage('docs/orbit-current', 'Orbit Current', 'Current destination.', 'status: current\n');
    await importPage(
      'docs/orbit-retired',
      'Orbit Retired',
      'Legacy orbit widget history unique phrase.',
      `status: superseded\nsuperseded_by: "[[docs/orbit-current]]"\n`,
    );

    const rows = await hybrid.hybridSearch(engine, 'history legacy orbit widget unique phrase', {
      limit: 10,
      expansion: false,
      useCache: false,
      graph_signals: false,
      relationalRetrieval: false,
    });
    const retired = rows.find((r) => r.slug === 'docs/orbit-retired');
    expect(retired).toMatchObject({
      lifecycle_status: 'superseded',
      superseded_by_page_id: successor.id,
      superseded_by: 'docs/orbit-current',
      stale: true,
    });
  });
});
