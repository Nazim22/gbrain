// Pins the wall-clock bound on extract_atoms — the LAST instance of the
// "a cost cap is not a bound when inference is free" family.
//
// extract-atoms is the file where that lesson was FIRST learned (S298 raised
// DEFAULT_BUDGET_USD to 1000 and then removed the cap entirely for free local
// models via isFreeLocalModel). Removing the cap was right for spend — and it
// left the loop with NO bound at all. It ran until the work list emptied or
// the enclosing job timeout killed it mid-item.
//
// So after synthesize_concepts was bounded on 2026-08-01, `autopilot-cycle`
// kept dying anyway: observed DEAD at 1823.4s against its 30-min ceiling,
// while the sibling job global-maintenance completed cleanly in 243.1s. Same
// bug, one file over — which is the whole reason this family keeps recurring.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

/** A free local model: answers, but has no canonical price — so no cost cap. */
function localChat(delayMs = 0): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return {
      text: JSON.stringify({ atoms: [{ title: 'a', body: 'b', concepts: [] }] }),
      blocks: [{ type: 'text', text: '' }],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'llama-server:gemma-4-12b-qat',
      providerId: 'llama-server',
    };
  };
}

// Real seam shape: { slug, content, contentHash }. Guessing it wrong made all
// three tests vacuous — no work items, so the loop never ran and every
// assertion passed for the wrong reason. Caught because the one test that
// asserts a POSITIVE (partial === true) failed; the two asserting absence
// passed happily on an empty run. A test that can only pass is not a test.
const pages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    slug: `notes/p${i}`,
    content: `# P${i}\n\nSome durable body text for page ${i} worth extracting atoms from.`,
    contentHash: `hash-${i}`,
  }));

describe('extract_atoms wall-clock bound', () => {
  test('THE BUG: a free model leaves no cost cap, so time must bound the loop', async () => {
    const res = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: pages(30) as never,
      _chat: localChat(20),       // 30 x 20ms of work available
      phaseBudgetMs: 80,          // ...against an 80ms budget
    } as never);

    const d = res.details as Record<string, unknown>;
    expect(d.partial).toBe(true);
    expect((d.transcripts_skipped_budget as number) + (d.pages_skipped_budget as number))
      .toBeGreaterThan(0);
    // Must NOT be reported as a spend decision — it is a time decision.
    expect(res.summary).toMatch(/PARTIAL/);
    expect(res.summary).not.toMatch(/budget-skipped/);
  }, 30000);

  test('an aborted job stops the loop rather than orphaning', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: pages(10) as never,
      _chat: localChat(),
      signal: ac.signal,
    } as never);
    expect((res.details as Record<string, unknown>).atoms_extracted).toBe(0);
  }, 30000);

  test('within budget nothing is skipped and it is not marked partial', async () => {
    const res = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: pages(2) as never,
      _chat: localChat(),
      phaseBudgetMs: 60_000,
    } as never);
    const d = res.details as Record<string, unknown>;
    expect(d.partial).toBe(false);
    expect(res.summary).not.toMatch(/PARTIAL/);
    // Anti-vacuous guard: prove the loop actually ITERATED. Without this, an
    // empty work list satisfies both assertions above and the test passes for
    // the wrong reason — exactly what the first draft of this file did.
    //
    // Asserts pages_processed, not atoms_extracted: the subject under test is
    // the wall-clock BOUND, not the atom parser. Tying it to parse output
    // would make this fail on any prompt/schema change that has nothing to do
    // with the bound.
    expect(d.pages_processed as number).toBeGreaterThan(0);
  }, 30000);
});
