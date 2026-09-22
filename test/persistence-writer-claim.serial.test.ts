import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { stringifyPersistenceAdminResult } from '../src/commands/persistence-admin.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-writer-claim-'));
const databasePath = join(home, 'claim-db');
const sourceRoot = join(home, 'claim-source');
const engine = new PGLiteEngine();

beforeAll(async () => {
  mkdirSync(databasePath);
  mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, 'page.md'), 'claim bytes');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath }));
  await engine.connect({ database_path: databasePath });
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['claim-source', sourceRoot]);
  await engine.disconnect();
}, 60_000);

afterAll(async () => {
  try { await engine.disconnect(); } catch { /* already disconnected */ }
  rmSync(home, { force: true, recursive: true });
});

async function claim(): Promise<{ claimed: boolean; binding: { worktree_id: string; owner_epoch: string | number } }> {
  const child = Bun.spawn([
    process.execPath, join(import.meta.dir, '../src/cli.ts'),
    'sources', 'writer', 'claim', 'claim-source', '--path', sourceRoot, '--json',
  ], {
    cwd: home,
    env: { ...process.env, GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toMatchObject({ code: 0, stderr: '' });
  return JSON.parse(stdout);
}

test('writer claim prints parseable JSON, records a manifest, and repairs an incomplete prior claim', async () => {
  const first = await claim();
  expect(first.claimed).toBe(true);
  expect(String(first.binding.owner_epoch)).toBe('1');

  await engine.connect({ database_path: databasePath });
  const [row] = await engine.executeRaw<{ manifest: { digest?: string; files?: Record<string, string> } | null }>(
    'SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [first.binding.worktree_id],
  );
  expect(row.manifest?.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(row.manifest?.files).toEqual({ 'page.md': expect.stringMatching(/^[a-f0-9]{64}$/) });
  await engine.executeRaw("UPDATE persistence_worktrees SET manifest='{}'::jsonb WHERE id=$1::uuid", [first.binding.worktree_id]);
  await engine.disconnect();

  const repaired = await claim();
  expect(repaired.binding.worktree_id).toBe(first.binding.worktree_id);
  await engine.connect({ database_path: databasePath });
  const [repairedRow] = await engine.executeRaw<{ manifest: { digest?: string } | null }>(
    'SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [first.binding.worktree_id],
  );
  expect(repairedRow.manifest?.digest).toMatch(/^[a-f0-9]{64}$/);
  await engine.disconnect();
}, 60_000);

test('writer administration output serializes bigint values as decimal strings', () => {
  expect(JSON.parse(stringifyPersistenceAdminResult({ owner_epoch: 1n, nested: { device: 42n } }))).toEqual({
    owner_epoch: '1', nested: { device: '42' },
  });
});
