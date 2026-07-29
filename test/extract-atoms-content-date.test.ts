// S395 — an atom's effective_date must be the SOURCE's date, not extraction
// time.
//
// The bug this pins: atoms carried no `date:` frontmatter and engine.putPage
// does not run computeEffectiveDate, so every atom's effective_date fell back
// to updated_at (= the dream-cycle run time). On an agent brain where atoms
// are ~80% of the corpus, recency-boosted ranking treated every extracted
// fact — including ones from months-old transcripts processed late — as
// stated "tonight", laundering stale facts as fresh and letting them outrank
// their own corrections.
//
// Fix: extract-atoms derives a content date per work item (date in the ref →
// transcript file mtime → run date) and writes BOTH `frontmatter.date` and
// the page's effective_date/effective_date_source columns.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { writeFileSync, utimesSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'atoms-date-'));
}, 60000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const ATOM_JSON = '[{"title":"dated-atom","atom_type":"insight","body":"a fact"}]';

function chatOnce(): (o: ChatOpts) => Promise<ChatResult> {
  return async () => ({
    text: ATOM_JSON,
    blocks: [{ type: 'text', text: ATOM_JSON }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'ollama:test',
    providerId: 'ollama',
  });
}

async function writtenAtom(): Promise<{ frontmatter: Record<string, unknown>; effective_date: string | null; effective_date_source: string | null }> {
  const rows = await engine.executeRaw(
    `SELECT frontmatter, effective_date::text AS effective_date, effective_date_source
       FROM pages WHERE slug LIKE 'atoms/%' AND deleted_at IS NULL`,
    [],
  ) as Array<{ frontmatter: Record<string, unknown>; effective_date: string | null; effective_date_source: string | null }>;
  expect(rows.length).toBe(1);
  return rows[0];
}

describe('S395 — atom effective_date derives from the source, not the run', () => {
  test('undated transcript filename → file mtime wins', async () => {
    const filePath = join(dir, 'session-0000-uuid.part1.txt'); // no date in name
    writeFileSync(filePath, 'substantive content');
    const past = new Date('2026-06-15T12:00:00Z');
    utimesSync(filePath, past, past);

    const r = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath, content: 'substantive content', contentHash: 'mtimecase1234567' }],
      _pages: [],
      _chat: chatOnce(),
    });
    expect((r.details as Record<string, unknown>).atoms_extracted).toBe(1);

    const atom = await writtenAtom();
    expect(atom.frontmatter.date).toBe('2026-06-15');
    expect(atom.effective_date?.slice(0, 10)).toBe('2026-06-15');
    expect(atom.effective_date_source).toBe('date');
  });

  test('dated ref beats mtime (deterministic sources stay deterministic)', async () => {
    const filePath = join(dir, '2026-05-01-telegram.txt');
    writeFileSync(filePath, 'other substantive content');
    const wrong = new Date('2026-07-01T12:00:00Z');
    utimesSync(filePath, wrong, wrong);

    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath, content: 'other substantive content', contentHash: 'datedcase1234567' }],
      _pages: [],
      _chat: chatOnce(),
    });

    const atom = await writtenAtom();
    expect(atom.frontmatter.date).toBe('2026-05-01');
    expect(atom.effective_date?.slice(0, 10)).toBe('2026-05-01');
  });

  test('missing file (test seams, deleted transcripts) falls back to run date — never throws', async () => {
    const r = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/nonexistent/T.txt', content: 'content', contentHash: 'missingcase12345' }],
      _pages: [],
      _chat: chatOnce(),
    });
    expect((r.details as Record<string, unknown>).atoms_extracted).toBe(1);

    const atom = await writtenAtom();
    const today = new Date().toISOString().slice(0, 10);
    expect(atom.frontmatter.date).toBe(today);
    expect(atom.effective_date_source).toBe('date');
  });
});
