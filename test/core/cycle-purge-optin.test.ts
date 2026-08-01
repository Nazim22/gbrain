// Pins that an UNATTENDED cycle does not hard-delete pages.
//
// runPhasePurge called engine.purgeDeletedPages() on every full cycle. That
// is an irreversible hard delete, and it ran as a side effect of any cycle —
// including one triggered purely to repair something else.
//
// 2026-08-01: a keeper ran a full cycle to clear doctor:cycle_freshness and
// it hard-deleted 59 pages. Nobody asked for a purge. In its own words:
// "I did not issue a purge command, but this was an irreversible side effect
// of the prescribed full-cycle remediation."
//
// It was survivable while full cycles were rare. It stopped being survivable
// the moment the full-cycle floor started firing hourly — the deletion went
// from never to once an hour, unattended.
//
// Deleting less than asked is safe; deleting more is not. So the destructive
// sweep is opt-in (GBRAIN_CYCLE_ALLOW_PURGE=1) and `gbrain purge-deleted`
// remains the deliberate, visible path.

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runCycle } from '../../src/core/cycle.ts';

let engine: PGLiteEngine;
let purgeCalls: number[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Record every hard-delete attempt rather than its result — the claim
  // under test is "was it CALLED", not "did it find rows".
  purgeCalls = [];
  const real = engine.purgeDeletedPages.bind(engine);
  (engine as any).purgeDeletedPages = async (hours: number) => {
    purgeCalls.push(hours);
    return real(hours);
  };
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  delete process.env.GBRAIN_CYCLE_ALLOW_PURGE;
  purgeCalls.length = 0;
});

describe('purge phase is opt-in for unattended cycles', () => {
  test('a plain cycle does NOT hard-delete pages', async () => {
    await runCycle(engine, { brainDir: '/tmp/brain-purge-optin', phases: ['purge'] });
    expect(purgeCalls).toEqual([]);
  });

  test('the phase still reports success — skipping is not failing', async () => {
    const res = await runCycle(engine, { brainDir: '/tmp/brain-purge-optin', phases: ['purge'] });
    const purge = res.phases?.find((p: any) => p.phase === 'purge');
    expect(purge?.status === 'ok' || purge?.status === 'warn').toBe(true);
  });

  test('explicit opt-in restores the sweep', async () => {
    process.env.GBRAIN_CYCLE_ALLOW_PURGE = '1';
    await runCycle(engine, { brainDir: '/tmp/brain-purge-optin', phases: ['purge'] });
    expect(purgeCalls.length).toBe(1);
    expect(purgeCalls[0]).toBe(72);   // the documented soft-delete TTL
  });

  test('any value other than exactly "1" stays safe', async () => {
    for (const v of ['0', 'true', 'yes', '']) {
      process.env.GBRAIN_CYCLE_ALLOW_PURGE = v;
      await runCycle(engine, { brainDir: '/tmp/brain-purge-optin', phases: ['purge'] });
    }
    expect(purgeCalls).toEqual([]);
  });
});
