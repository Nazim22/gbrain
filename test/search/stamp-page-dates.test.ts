// Pins the recall date stamp.
//
// Recall rendered `[0.6438] memory/…-s300 -- <snippet>` — a score and nothing
// else. A page written in May and one written this morning looked IDENTICAL,
// so a rotted state-claim was indistinguishable from a settled decision.
//
// Real cost, 2026-08-01: the top hit for `synthesize_concepts` was an S300 page
// asserting the phase was "dead" — while that phase was the day's live
// production bug. It was caught by probing the running system, i.e. not caught
// by the brain at all.
//
// The subtle part: `updated_at` ALONE is worse than useless here. A vault
// re-sync touches it without changing a word, so old knowledge renders fresh.
// That S300 page was authored 06-20 and stamped 07-28; 2,644 of 15,811 pages
// (17%) carry that gap. Showing the touch date would have made the single most
// misleading page in the brain look current.

import { describe, test, expect } from 'bun:test';
import { stampPageDates } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function fakeEngine(rows: Array<{ id: number; created_at: unknown; updated_at: unknown }>) {
  return { executeRaw: async () => rows } as any;
}

const result = (page_id: number): SearchResult =>
  ({ page_id, slug: `p${page_id}`, score: 1, stale: false } as unknown as SearchResult);

describe('stampPageDates', () => {
  test('THE BUG: a re-synced old page shows its AUTHORED date, not the touch', async () => {
    const rs = [result(1)];
    await stampPageDates(
      fakeEngine([{ id: 1, created_at: '2026-06-20T10:00:00Z', updated_at: '2026-07-28T02:00:00Z' }]),
      rs,
    );
    // Must NOT render as plain "2026-07-28" — that reads as fresh.
    expect(rs[0].updated_at).toBe('2026-06-20→07-28');
  });

  test('an untouched page shows one clean date', async () => {
    const rs = [result(2)];
    await stampPageDates(
      fakeEngine([{ id: 2, created_at: '2026-07-29T09:00:00Z', updated_at: '2026-07-29T09:00:00Z' }]),
      rs,
    );
    expect(rs[0].updated_at).toBe('2026-07-29');
  });

  test('falls back to the touch date when authored date is missing', async () => {
    const rs = [result(3)];
    await stampPageDates(fakeEngine([{ id: 3, created_at: null, updated_at: '2026-07-01T00:00:00Z' }]), rs);
    expect(rs[0].updated_at).toBe('2026-07-01');
  });

  test('leaves the field unset rather than inventing a date', async () => {
    const rs = [result(4)];
    await stampPageDates(fakeEngine([{ id: 4, created_at: null, updated_at: null }]), rs);
    expect(rs[0].updated_at).toBeUndefined();
  });

  test('a lookup failure must NEVER break retrieval', async () => {
    const rs = [result(5)];
    const broken = { executeRaw: async () => { throw new Error('db down'); } } as any;
    await stampPageDates(broken, rs);      // must not throw
    expect(rs[0].updated_at).toBeUndefined();
    expect(rs[0].slug).toBe('p5');          // result itself survives intact
  });

  test('empty result set is a no-op', async () => {
    await stampPageDates(fakeEngine([]), []);   // must not throw
  });
});
