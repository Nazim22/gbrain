// S409 review fix (Dae P1) — the search_embedding_column physical gate must
// reject NON-VECTOR physical types, run UNCONDITIONALLY (no file-config
// dependency), and resolve the table via ::regclass. Dae's probe: a TEXT
// column declared vector(3) in the registry was accepted and persisted.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runConfig } from '../src/commands/config.ts';

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

/** Capture process.exit + console.error without terminating the test run. */
async function captureRun(args: string[]): Promise<{ exitCode: number | null; stderr: string }> {
  const origExit = process.exit;
  const origErr = console.error;
  let exitCode: number | null = null;
  let stderr = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${code}__`);
  };
  console.error = (...a: unknown[]) => { stderr += a.map(String).join(' ') + '\n'; };
  try {
    await runConfig(engine, args);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit_')) throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
  return { exitCode, stderr };
}

describe('S409 search_embedding_column physical gate', () => {
  test("Dae's exact repro: a TEXT column DECLARED vector(3) in the registry is refused", async () => {
    await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_bad TEXT`);
    // Register it as vector(3) the way the operator would — this passed the
    // registry gate pre-fix, and the physical regex only compared when it
    // already matched vector/halfvec, so TEXT slid through and PERSISTED.
    const reg = await captureRun(['set', 'embedding_columns',
      JSON.stringify({ embedding_bad: { dimensions: 3, provider: 'test:model-x', type: 'vector' } })]);
    expect(reg.exitCode).toBeNull(); // registry write itself succeeds
    const r = await captureRun(['set', 'search_embedding_column', 'embedding_bad', '--yes']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not a');
    const persisted = await engine.getConfig('search_embedding_column');
    expect(persisted).not.toBe('embedding_bad');
  });

  test('a registered but physically missing column is refused', async () => {
    const reg = await captureRun(['set', 'embedding_columns',
      JSON.stringify({ embedding_ghost: { dimensions: 1024, provider: 'test:model-x', type: 'vector' } })]);
    expect(reg.exitCode).toBeNull();
    const r = await captureRun(['set', 'search_embedding_column', 'embedding_ghost', '--yes']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('does NOT physically exist');
    expect(await engine.getConfig('search_embedding_column')).not.toBe('embedding_ghost');
  });

  test("R2 (Dae's no-file repro): with NO config file, a DB-declared vector(3) override of the builtin is refused against the physical width", async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const emptyHome = mkdtempSync(join(tmpdir(), 'gbrain-s409-nofile-'));
    const savedHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = emptyHome;
    try {
      // DB-plane registry declares the BUILTIN column at the wrong width.
      const reg = await captureRun(['set', 'embedding_columns',
        JSON.stringify({ embedding: { dimensions: 3, provider: 'test:model-x', type: 'vector' } })]);
      expect(reg.exitCode).toBeNull();
      // Pre-R2: fileCfg null → merge skipped → declaredEntry null → the
      // physical gate saw a valid vector type and PERSISTED the mismatch.
      const r = await captureRun(['set', 'search_embedding_column', 'embedding', '--yes']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('does not match its');
      expect(await engine.getConfig('search_embedding_column')).not.toBe('embedding');
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test('the real default vector column still passes the physical gate', async () => {
    const r = await captureRun(['set', 'search_embedding_column', 'embedding', '--yes']);
    // Physical gate passes (vector(n) exists); whatever happens later in the
    // command must not be the physical-gate refusal.
    expect(r.stderr).not.toContain('does NOT physically exist');
    expect(r.stderr).not.toContain('not a');
  });
});
