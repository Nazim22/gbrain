// S409 — propose_takes repair wave (audit item 3 + the S405 verified
// diagnosis). Four contracts:
//   1. BACKLOG DRAIN: eligibility is filtered in SQL and pageLimit bounds
//      LLM work, so a 250-page backlog drains across runs instead of the
//      newest-100 window starving page 101+ forever.
//   2. RETRY LEDGER: an extractor failure records an attempt with backoff;
//      the page is excluded while backing off; success clears the ledger.
//   3. MODEL ROUTE: `models.dream.propose_takes` (and the deprecated
//      `cycle.propose_takes.model`) are CONSUMED — the resolved id reaches
//      the extractor as modelHint (was: opts.model, always undefined in
//      production, so a config key was accepted and silently ignored).
//   4. TAXONOMY: the tuned prompt's 'prediction'/'judgment' map to storage
//      kinds 'bet'/'take' instead of collapsing to generic 'take'.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  parseExtractorOutput,
  runPhaseProposeTakes,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';

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

function context(config: Record<string, unknown> = {}): OperationContext {
  return {
    engine,
    config: config as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

async function seedPages(n: number, prefix = 'wiki/bulk'): Promise<void> {
  // Raw INSERT keeps 250 pages fast (putPage would chunk each one).
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
     SELECT 'default', '${prefix}/p' || i, 'note', 'p' || i,
            'This page asserts claim number ' || i || ' with conviction.'
       FROM generate_series(1, $1) AS i`,
    [n],
  );
}

const oneClaim: ProposeTakesExtractor = async (input) => [
  { claim_text: `Claim from ${input.pagePath}`, kind: 'take', holder: 'brain', weight: 0.6 },
];

describe('S409.1 backlog drain', () => {
  test('a 250-page backlog fully drains across three pageLimit=100 runs', async () => {
    await seedPages(250);

    const distinctProposedPages = async (): Promise<number> => {
      const rows = await engine.executeRaw<{ n: string }>(
        `SELECT COUNT(DISTINCT page_slug)::text AS n FROM take_proposals`,
      );
      return Number(rows[0]!.n);
    };

    const r1 = await runPhaseProposeTakes(context(), { extractor: oneClaim, pageLimit: 100 });
    expect((r1.details as Record<string, unknown>).cache_misses).toBe(100);
    expect(await distinctProposedPages()).toBe(100);

    const r2 = await runPhaseProposeTakes(context(), { extractor: oneClaim, pageLimit: 100 });
    expect(await distinctProposedPages()).toBe(200);

    const r3 = await runPhaseProposeTakes(context(), { extractor: oneClaim, pageLimit: 100 });
    expect(await distinctProposedPages()).toBe(250);

    // A fourth run finds nothing eligible — no scans, no spend.
    const r4 = await runPhaseProposeTakes(context(), { extractor: oneClaim, pageLimit: 100 });
    expect((r4.details as Record<string, unknown>).pages_scanned).toBe(0);
    expect((r4.details as Record<string, unknown>).cache_misses).toBe(0);
  }, 120_000);
});

describe('S409.2 retry ledger', () => {
  const failing: ProposeTakesExtractor = async () => {
    throw new Error('no parseable takes JSON (transient — retry)');
  };

  test('failure records an attempt with backoff; page excluded while backing off; success clears it', async () => {
    await seedPages(1, 'wiki/flaky');

    const r1 = await runPhaseProposeTakes(context(), { extractor: failing, pageLimit: 10 });
    expect((r1.details as Record<string, unknown>).retries_recorded).toBe(1);

    const ledger = await engine.executeRaw<{
      attempt_count: number; dead_letter: boolean; last_error: string;
    }>(`SELECT attempt_count, dead_letter, last_error FROM take_proposal_attempts`);
    expect(ledger.length).toBe(1);
    expect(Number(ledger[0]!.attempt_count)).toBe(1);
    expect(ledger[0]!.dead_letter).toBe(false);
    expect(ledger[0]!.last_error).toContain('no parseable takes JSON');

    // Backing off (next_retry_at is ~1h out) → not a candidate.
    const r2 = await runPhaseProposeTakes(context(), { extractor: oneClaim, pageLimit: 10 });
    expect((r2.details as Record<string, unknown>).pages_scanned).toBe(0);

    // Force the backoff window open; the page retries and succeeds; ledger clears.
    await engine.executeRaw(`UPDATE take_proposal_attempts SET next_retry_at = now() - interval '1 minute'`);
    const r3 = await runPhaseProposeTakes(context(), { extractor: oneClaim, pageLimit: 10 });
    expect((r3.details as Record<string, unknown>).proposals_inserted).toBe(1);
    const after = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM take_proposal_attempts`,
    );
    expect(Number(after[0]!.n)).toBe(0);
  });

  test('repeated same-content failures dead-letter at 8 attempts', async () => {
    await seedPages(1, 'wiki/poison');
    for (let i = 0; i < 8; i++) {
      await runPhaseProposeTakes(context(), { extractor: failing, pageLimit: 10 });
      await engine.executeRaw(
        `UPDATE take_proposal_attempts SET next_retry_at = now() - interval '1 minute'`,
      );
    }
    const rows = await engine.executeRaw<{ attempt_count: number; dead_letter: boolean }>(
      `SELECT attempt_count, dead_letter FROM take_proposal_attempts`,
    );
    expect(Number(rows[0]!.attempt_count)).toBe(8);
    expect(rows[0]!.dead_letter).toBe(true);

    // Dead-lettered page never re-enters, even with the window open.
    const r = await runPhaseProposeTakes(context(), { extractor: oneClaim, pageLimit: 10 });
    expect((r.details as Record<string, unknown>).pages_scanned).toBe(0);
  });
});

describe('S409.3 model route', () => {
  test('models.dream.propose_takes reaches the extractor as modelHint', async () => {
    await seedPages(1, 'wiki/routed');
    let seenHint: string | undefined;
    const capture: ProposeTakesExtractor = async (input) => {
      seenHint = input.modelHint;
      return [];
    };
    await runPhaseProposeTakes(
      context({ 'models.dream.propose_takes': 'anthropic:claude-haiku-4-5' }),
      { extractor: capture, pageLimit: 10 },
    );
    expect(seenHint).toBe('anthropic:claude-haiku-4-5');
  });

  test('deprecated cycle.propose_takes.model is honored when the new key is absent', async () => {
    await seedPages(1, 'wiki/legacy-routed');
    let seenHint: string | undefined;
    const capture: ProposeTakesExtractor = async (input) => {
      seenHint = input.modelHint;
      return [];
    };
    await runPhaseProposeTakes(
      context({ 'cycle.propose_takes.model': 'legacy:model-x' }),
      { extractor: capture, pageLimit: 10 },
    );
    expect(seenHint).toBe('legacy:model-x');
  });

  test('with no route configured, the global chat model reaches the extractor (not undefined)', async () => {
    await seedPages(1, 'wiki/default-routed');
    let seenHint: string | undefined | null = null;
    const capture: ProposeTakesExtractor = async (input) => {
      seenHint = input.modelHint;
      return [];
    };
    await runPhaseProposeTakes(context(), { extractor: capture, pageLimit: 10 });
    // Pre-S409 this was undefined in every production run.
    expect(typeof seenHint).toBe('string');
    expect((seenHint as unknown as string).length).toBeGreaterThan(0);
  });
});

describe('S409.4 taxonomy alignment', () => {
  test("prompt kinds 'prediction'/'judgment' map to storage kinds 'bet'/'take'", () => {
    const parsed = parseExtractorOutput(JSON.stringify([
      { claim_text: 'X will hit ARR by Q3', kind: 'prediction', holder: 'brain', weight: 0.7 },
      { claim_text: 'Y will struggle with execution', kind: 'judgment', holder: 'brain', weight: 0.6 },
      { claim_text: 'I bet alice wins', kind: 'bet', holder: 'brain', weight: 0.8 },
      { claim_text: 'unknown kind falls back', kind: 'vibe', holder: 'brain', weight: 0.5 },
    ]));
    expect(parsed.map((p) => p.kind)).toEqual(['bet', 'take', 'bet', 'take']);
  });
});
