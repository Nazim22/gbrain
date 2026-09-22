import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function localChat(delayMs = 0): (opts: ChatOpts) => Promise<ChatResult> {
  return async () => {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return {
      text: '[]',
      blocks: [{ type: 'text', text: '[]' }],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'ollama:qwen3',
      providerId: 'ollama',
    };
  };
}

const pages = (n: number) => Array.from({ length: n }, (_, i) => ({
  slug: `notes/p${i}`,
  content: `# P${i}\n\n${'Durable engineering detail. '.repeat(30)}`,
  contentHash: `hash-${i}`,
}));

describe('extract_atoms wall-clock bound', () => {
  test('stops before starting more work after the phase budget', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: pages(20),
      _chat: localChat(20),
      phaseBudgetMs: 70,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.partial).toBe(true);
    expect((details.pages_processed as number)).toBeGreaterThan(0);
    expect((details.pages_skipped_budget as number)).toBeGreaterThan(0);
    expect(result.summary).toContain('PARTIAL');
    expect(result.summary).not.toContain('budget-skipped');
  }, 30_000);

  test('an already-aborted run starts no item', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: pages(2),
      _chat: localChat(),
      signal: controller.signal,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.pages_processed).toBe(0);
    expect(details.partial).toBe(true);
  }, 30_000);
});
