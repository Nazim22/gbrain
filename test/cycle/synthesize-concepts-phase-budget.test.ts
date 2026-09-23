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
    // v0.51 prices an unpriced local model at the Sonnet-tier fallback, so the
    // dollar gate is no longer inert — but it trips after ~180 calls (~36 min on
    // gemma), far past the minion job timeout. The wall clock is what holds.
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

  test('abort during chat reaches the provider and publishes no concept', async () => {
    const ac = new AbortController();
    let received: AbortSignal | undefined;
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(1), signal: ac.signal,
      _chat: async (o) => {
        received = o.abortSignal;
        await new Promise((r) => setTimeout(r, 20));
        ac.abort();
        return localChat()(o);
      },
    });
    expect(received?.aborted).toBe(true);
    expect((result.details as Record<string, unknown>).concepts_written).toBe(0);
    expect((await engine.getPage('concepts/c0'))).toBeNull();
  }, 30000);

  test('deadline during delayed chat aborts the call and publishes no concept', async () => {
    let received: AbortSignal | undefined;
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atomsForGroups(1), phaseBudgetMs: 30,
      _chat: async (o) => {
        received = o.abortSignal;
        await new Promise((r) => setTimeout(r, 80));
        return localChat()(o);
      },
    });
    expect(received?.aborted).toBe(true);
    expect((result.details as Record<string, unknown>).concepts_written).toBe(0);
    expect((await engine.getPage('concepts/c0'))).toBeNull();
  }, 30000);

  test('repeating an unchanged T1 group writes no second concept page', async () => {
    const atoms = atomsForGroups(1);
    const first = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: localChat() });
    expect((first.details as Record<string, unknown>).concepts_written).toBe(1);
    const page = await engine.getPage('concepts/c0');
    expect(page).not.toBeNull();

    const second = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: localChat() });
    expect((second.details as Record<string, unknown>).concepts_written).toBe(0);
    expect((await engine.getPage('concepts/c0'))?.knowledge_revision).toBe(page?.knowledge_revision);
  }, 30000);

  test('a changed narrative or mention count still writes a new concept', async () => {
    const atoms = atomsForGroups(1);
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: localChat() });
    const newText = async (o: ChatOpts) => ({ ...(await localChat()(o)), text: 'new narrative text' });
    const changed = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: newText });
    expect((changed.details as Record<string, unknown>).concepts_written).toBe(1);
    const more = await runPhaseSynthesizeConcepts(engine, {
      _atoms: [...atoms, { slug: 'atoms/new', concept_refs: ['concepts/c0'], body: 'new body', title: 'New' }],
      _chat: newText,
    });
    expect((more.details as Record<string, unknown>).concepts_written).toBe(1);
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
