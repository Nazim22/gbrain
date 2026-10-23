import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import { OP_READ_TRUST } from '../src/core/eligibility/registry.ts';

describe('reflex_pointers operation contract', () => {
  test('publishes the read-only host bridge with bounded pointer controls', () => {
    const op = operationsByName.reflex_pointers;
    expect(op?.scope).toBe('read');
    expect(op?.mutating).toBe(false);
    expect(op?.outputRedaction).toBe('retrieval');
    expect(op?.params.text?.required).toBe(true);
    expect(op?.params.prior_context?.type).toBe('string');
    expect(op?.params.max_pointers?.type).toBe('number');
    expect('min_trust' in (op?.params ?? {})).toBe(true);
    expect(OP_READ_TRUST.reflex_pointers).toBe('filtered');
  });
});
