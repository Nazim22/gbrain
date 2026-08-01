// Pins the full-cycle floor against the "healthy brain never cycles" trap.
//
// The gate was:
//   (score >= 95 && plan.length === 0 && minutesSinceLastFull >= 60)
//   || plan.length > 3 || estTotal >= 300 || score < 70
//
// A brain at score 98 carrying a small but PERSISTENT plan (2 remediable
// items) matches none of those. Not the first clause — the plan is not empty.
// Not `> 3`, not `estTotal >= 300`, not `score < 70`. So it returned false on
// every tick forever: only targeted handlers ran, lastFullCycleAt never
// advanced, and doctor:cycle_freshness went stale — which is a WARN, so it
// never dragged the score under 70 to trip the hammer either. A stable trap.
//
// Observed 2026-08-01: 4h+, zero full cycles, "last cycled 6h ago", overall
// health 75 -> 70.

import { describe, test, expect } from 'bun:test';
import { shouldRunFullCycle } from '../src/commands/autopilot.ts';

const FLOOR = 60;
const base = { estTotalSeconds: 10, floorMin: FLOOR };

describe('full-cycle floor', () => {
  test('THE TRAP: healthy score + small persistent plan still cycles on the clock', () => {
    // Exactly the live state that stalled: score 98, plan 2, cheap, 4h since.
    expect(shouldRunFullCycle({
      ...base, score: 98, planLength: 2, minutesSinceLastFull: 240,
    })).toBe(true);
  });

  test('a non-empty plan does not exempt a brain from the floor', () => {
    for (const planLength of [1, 2, 3]) {
      expect(shouldRunFullCycle({
        ...base, score: 98, planLength, minutesSinceLastFull: 61,
      })).toBe(true);
    }
  });

  test('inside the floor window, a healthy brain still uses targeted handlers', () => {
    // The floor is a floor, not a mandate — don't hammer every tick.
    expect(shouldRunFullCycle({
      ...base, score: 98, planLength: 2, minutesSinceLastFull: 10,
    })).toBe(false);
    expect(shouldRunFullCycle({
      ...base, score: 98, planLength: 0, minutesSinceLastFull: 10,
    })).toBe(false);
  });

  test('the pre-existing escalation branches are untouched', () => {
    // Large plan -> hammer, regardless of recency.
    expect(shouldRunFullCycle({ ...base, score: 98, planLength: 4, minutesSinceLastFull: 0 })).toBe(true);
    // Expensive plan -> hammer.
    expect(shouldRunFullCycle({
      score: 98, planLength: 1, estTotalSeconds: 300, minutesSinceLastFull: 0, floorMin: FLOOR,
    })).toBe(true);
    // Low score -> hammer.
    expect(shouldRunFullCycle({ ...base, score: 69, planLength: 0, minutesSinceLastFull: 0 })).toBe(true);
  });

  test('a degraded brain is not made to wait for the floor', () => {
    expect(shouldRunFullCycle({
      ...base, score: 50, planLength: 0, minutesSinceLastFull: 0,
    })).toBe(true);
  });
});
