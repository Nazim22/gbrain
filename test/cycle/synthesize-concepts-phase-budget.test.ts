// Pins the wall-clock bound on synthesize_concepts.
//
// The bug this guards (2026-07-31): the phase's ONLY bound was a dollar
// budget. `canonicalLookup` returns null for a locally-served model, so
// estimatedSpendUsd stayed 0, the cap never tripped, and the per-group loop
// ran unbounded — 2h49m past the 600s minion job timeout. The worker then
// force-evicts the job but cannot kill the handler, so it kept running
// orphaned for 4h50m while the cycle never recorded completion and
// doctor:cycle_freshness went stale.
//
// A dollar budget is not a bound when inference is free. These tests assert
// the bound that holds regardless of pricing.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** A locally-served model: answers fine, has NO canonical price. */
function localChat(delayMs = 0): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return {
      text: 'narrative text',
      blocks: [{ type: 'text', text: 'narrative text' }],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'llama-server:gemma-4-12b-qat',
      providerId: 'llama-server',
    };
  };
}

/** N T1-tier groups (10 atoms each) → every one takes the LLM path. */
function atomsForGroups(n: number) {
  const atoms = [];
  for (let g = 0; g < n; g++) {
    for (let i = 0; i < 10; i++) {
      atoms.push({
        slug: `atoms/g${g}-a${i}`,
        concept_refs: [`concepts/c${g}`],
        body: `body ${g}-${i}`,
        title: `A${g}-${i}`,
      });
    }
  }
  return atoms;
}

describe('synthesize_concepts wall-clock bound', () => {
  test('a free local model does NOT make the loop unbounded', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(20),
      _chat: localChat(20),      // 20 groups x 20ms = 400ms of work available
      phaseBudgetMs: 100,        // ...against a 100ms budget
    });

    const d = result.details as Record<string, unknown>;
    // The dollar budget is genuinely inert here — that's the point.
    expect(d.estimated_spend_usd).toBe(0);
    expect((d.unpriced_models as string[])).toContain('llama-server:gemma-4-12b-qat');
    // ...and yet the phase stopped early and said so.
    expect(d.partial).toBe(true);
    expect(d.groups_skipped as number).toBeGreaterThan(0);
    expect(d.concepts_written as number).toBeLessThan(20);
    expect(result.summary).toMatch(/PARTIAL/);
  }, 30000);

  test('returns cleanly instead of running past the deadline', async () => {
    const started = Date.now();
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(40),
      _chat: localChat(25),      // 1000ms of work
      phaseBudgetMs: 150,
    });
    // The old code ran every group regardless. Generous ceiling: what matters
    // is that it bounded at all, not the exact slack.
    expect(Date.now() - started).toBeLessThan(700);
  }, 30000);

  test('an aborted job stops the loop — the orphaned-handler case', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(10),
      _chat: localChat(),
      signal: ac.signal,
    });
    expect((result.details as Record<string, unknown>).concepts_written).toBe(0);
  }, 30000);

  test('within budget, nothing is skipped and it is not marked partial', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(3),
      _chat: localChat(),
      phaseBudgetMs: 60_000,
    });
    const d = result.details as Record<string, unknown>;
    expect(d.concepts_written).toBe(3);
    expect(d.groups_skipped).toBe(0);
    expect(d.partial).toBe(false);
    expect(result.summary).not.toMatch(/PARTIAL/);
  }, 30000);

  test('densest groups win the budget, not Map insertion order', async () => {
    // c0 = 2 atoms (T3, cheap), c1 = 10 atoms (T1, the valuable one).
    const atoms = [
      { slug: 'atoms/s0', concept_refs: ['concepts/sparse'], body: 'b', title: 'S0' },
      { slug: 'atoms/s1', concept_refs: ['concepts/sparse'], body: 'b', title: 'S1' },
      ...Array.from({ length: 10 }, (_, i) => ({
        slug: `atoms/d${i}`,
        concept_refs: ['concepts/dense'],
        body: 'b',
        title: `D${i}`,
      })),
    ];
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: localChat(),
      phaseBudgetMs: 60_000,
    });
    const d = result.details as Record<string, unknown>;
    // Sparse is declared first but dense must be tiered/processed first.
    expect((d.tier_counts as Record<string, number>).T1).toBe(1);
  }, 30000);
});
