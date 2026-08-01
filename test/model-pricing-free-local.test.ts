// Guards the "a cost cap is not a bound when inference is free" bug class.
//
// This has now bitten THREE times, each time in a different file, each time
// after cognition moved to a locally-served model:
//   S298  extract_atoms      — budget 0.3 vs free ollama → BudgetExhausted on
//                              every call; "0 atoms (55 budget-skipped)",
//                              atom coverage silently froze.
//   S398+ synthesize_concepts — price lookup returns null → spend stayed 0 →
//                              the $1.50 cap never tripped → the phase ran
//                              2h49m past a 600s job timeout and orphaned.
//   (same) brainstorm         — unpriced model fell back to Sonnet rates → a
//                              free run accrued invented spend and the mid-run
//                              guard cut work short.
//
// Note the two failure directions: under-count (cap never trips, runs forever)
// and over-count (cap trips immediately, silently does nothing). Both report
// success. The regex having lived privately in ONE file is why the sibling
// phase drifted, so the helper now has a single home and this file pins it.

import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isFreeLocalModel, canonicalLookup } from '../src/core/model-pricing.ts';

describe('isFreeLocalModel', () => {
  test('recognises every locally-served provider prefix in use', () => {
    for (const id of [
      'ollama:qwen3-30b',
      'llama-server:gemma-4-12b-qat',
      'llama-server-reranker:bge-reranker-v2-m3',
      'lmstudio:whatever',
      'local:foo',
      'vllm:bar',
      'LLAMA-SERVER:CasE-InSeNsItIvE',
    ]) {
      expect(isFreeLocalModel(id)).toBe(true);
    }
  });

  test('does not claim paid cloud models are free', () => {
    for (const id of [
      'anthropic:claude-sonnet-4-6',
      'openai:gpt-5',
      'google:gemini-2.0-flash',
      'openrouter:qwen/qwen3-235b-a22b-2507',
    ]) {
      expect(isFreeLocalModel(id)).toBe(false);
    }
  });

  test('is null-safe — an unset model is not "free", it is unknown', () => {
    expect(isFreeLocalModel(undefined)).toBe(false);
    expect(isFreeLocalModel(null)).toBe(false);
    expect(isFreeLocalModel('')).toBe(false);
  });

  test('the premise holds: local models have no canonical price', () => {
    // This is WHY the caps failed. If this ever becomes false the helper is
    // redundant — but so long as it is true, every spend-gated caller needs it.
    expect(canonicalLookup('llama-server:gemma-4-12b-qat')).toBeUndefined();
    expect(canonicalLookup('ollama:qwen3-30b')).toBeUndefined();
  });
});

describe('no caller re-implements the free-local check privately', () => {
  test('the provider regex has exactly one home', () => {
    const srcDir = new URL('../src/', import.meta.url).pathname;
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        if (p.endsWith('model-pricing.ts')) continue;   // the one home
        const body = readFileSync(p, 'utf8');
        // A private copy of the provider-prefix test — the thing that let the
        // sibling phase drift. Import the helper instead.
        if (/\/\^?\(?\s*(ollama|llama-server|lmstudio)\b[^/\n]*\/i?\s*\.test\(/.test(body)) {
          offenders.push(p.slice(srcDir.length));
        }
      }
    };
    walk(srcDir);

    expect(offenders).toEqual([]);
  });
});
