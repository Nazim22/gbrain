/**
 * Capture every row a manifest batch could touch, with full state (DESIGN.md §8b, r4). READ ONLY.
 * Usage: DATABASE_URL=... bun writeset.ts capture <manifest> <corpusDir> <out.json> [--like <before.json>]   (AFTER: reuse BEFORE's receipt families)
 *        DATABASE_URL=... bun writeset.ts preflight <before.json>                                   (exit 1 unless clean)
 */
import postgres from 'postgres';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';

export const OWN = 'luna-batch-rollback';
export type Pair = { hash16: string; path: string; ownerKey: string };
export type Capture = {
  manifest_sha256: string; captured_at: string; pairs: Pair[]; receipt_families: string[];
  atoms: Array<{ id: number; slug: string; deleted_at: string | null; content_hash: string | null; frontmatter: any; compiled_truth: string; pair: string }>;
  generations: Array<{ id: number; owner_key: string; generation: number; state: string; run_id: string | null; input_pin: string | null; item_set_hash: string }>;
  items: Array<{ generation_id: number; item_key: string; identity_hash: string; action: string; pending: boolean }>;
  state_rows: Array<{ file_path: string; content_hash: string; fail_count: number; tombstoned: boolean; partial_input_chars: number | null }>;
  // Receipt slugs are per day (extracts/<date>/atoms/<source>/…): a later run REUSES and un-deletes the same row, so receipts
  // are captured with full state like atoms (found on scratch round 2, 2026-10-26).
  receipts: Array<{ id: number; slug: string; deleted_at: string | null; content_hash: string | null; frontmatter: any; compiled_truth: string; pair: string }>;
};

export function readManifest(path: string, corpusDir: string): { pairs: Pair[]; sha: string } {
  const text = readFileSync(path, 'utf8');
  const pairs = text.split('\n').filter(Boolean).map(l => {
    const [hash16, p] = l.split('\t');
    if (!/^[0-9a-f]{16}$/.test(hash16) || !p) throw Error(`bad manifest line: ${l.slice(0, 60)}`);
    return { hash16, path: p, ownerKey: `transcript:corpus/${relative(resolve(corpusDir), resolve(p)).split(sep).join('/')}` };
  });
  return { pairs, sha: createHash('sha256').update(text).digest('hex') };
}

export async function capture(sql: postgres.Sql, pairs: Pair[], manifestSha: string, familiesFrom?: string[]): Promise<Capture> {
  const hashes = pairs.flatMap(p => [p.hash16, `pending:${p.hash16}`]), paths = pairs.map(p => p.path), keys = pairs.map(p => p.ownerKey);
  return sql.begin('READ ONLY', async tx => {
    const atoms = await tx`SELECT id, slug, deleted_at, content_hash, frontmatter, compiled_truth,
        COALESCE(frontmatter->>'source_hash','') AS h, COALESCE(frontmatter->>'source_path','') AS p
      FROM pages WHERE type='atom' AND source_id='default'
        AND (frontmatter->>'source_hash' = ANY(${hashes}) OR frontmatter->>'source_path' = ANY(${paths})) ORDER BY id`;
    const generations = await tx`SELECT id, owner_key, generation, state, run_id, input_pin, item_set_hash FROM derived_generations
      WHERE source_id='default' AND kind='atom' AND owner_key = ANY(${keys}) ORDER BY id`;
    const items = generations.length ? await tx`SELECT generation_id, item_key, identity_hash, action, pending FROM derived_generation_items
      WHERE generation_id = ANY(${generations.map((g: any) => g.id)}) ORDER BY generation_id, item_key` : [];
    const state_rows = await tx`SELECT file_path, content_hash, fail_count, tombstoned, partial_input_chars FROM extract_atoms_transcript_state
      WHERE source_id='default' AND file_path = ANY(${paths}) ORDER BY file_path, content_hash`;
    // Exact candidate identities, regardless of age: a run's receipt slug is extracts/<UTC date of the run>/atoms/<source>/
    // <first 8 of the run id>/round-single (receipt-writer.ts receiptSlug), so every receipt this run could write or reuse is in
    // the UTC-today or UTC-tomorrow atoms family (a run may cross midnight).
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    // AFTER reuses BEFORE's families, so a run that crosses midnight compares the same receipt rows.
    const families = familiesFrom ?? [day(Date.now()), day(Date.now() + 86_400_000)].map(d => `extracts/${d}/atoms/default/%`);
    const receipts = await tx`SELECT id, slug, deleted_at, content_hash, frontmatter, compiled_truth FROM pages
      WHERE type='extract_receipt' AND source_id='default' AND (slug LIKE ${families[0]} OR slug LIKE ${families[1]}) ORDER BY id`;
    const pairOf = (a: any) => pairs.find(p => p.path === a.p || a.h === p.hash16 || a.h === `pending:${p.hash16}`)?.path ?? '';
    return {
      manifest_sha256: manifestSha, captured_at: new Date().toISOString(), pairs, receipt_families: families,
      atoms: atoms.map((a: any) => ({ id: Number(a.id), slug: a.slug, deleted_at: a.deleted_at ? new Date(a.deleted_at).toISOString() : null, content_hash: a.content_hash, frontmatter: a.frontmatter, compiled_truth: a.compiled_truth, pair: pairOf(a) })),
      generations: generations.map((g: any) => ({ ...g, id: Number(g.id) })), items: items.map((i: any) => ({ ...i, generation_id: Number(i.generation_id) })),
      state_rows: [...state_rows], receipts: receipts.map((r: any) => ({ id: Number(r.id), slug: r.slug, deleted_at: r.deleted_at ? new Date(r.deleted_at).toISOString() : null, content_hash: r.content_hash, frontmatter: r.frontmatter, compiled_truth: r.compiled_truth, pair: '' })),
    } as Capture;
  });
}

/** Preflight (r4): every captured row is absent or exactly rollback-owned; anything else blocks the batch. */
export function preflight(c: Capture): string[] {
  const bad: string[] = [];
  for (const a of c.atoms) if (!(a.deleted_at && a.frontmatter?.retired_by === OWN)) bad.push(`atom ${a.id} (${a.deleted_at ? `retired_by=${a.frontmatter?.retired_by ?? 'none'}` : 'live'})`);
  for (const g of c.generations) bad.push(`generation ${g.id} ${g.owner_key} state=${g.state}`);
  for (const s of c.state_rows) bad.push(`state ${s.file_path} ${s.content_hash}`);
  return bad;
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'capture') {
    const [manifest, corpusDir, out, flag, like] = rest;
    const { pairs, sha } = readManifest(manifest, corpusDir);
    const families = flag === '--like' ? (JSON.parse(readFileSync(like, 'utf8')) as Capture).receipt_families : undefined;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    const c = await capture(sql, pairs, sha, families); await sql.end();
    const text = JSON.stringify(c, null, 1);
    writeFileSync(out, text, { mode: 0o600, flag: 'wx' });   // no-clobber: an attempt's capture is never overwritten
    console.log(JSON.stringify({ out, sha256: createHash('sha256').update(text).digest('hex'), pairs: pairs.length, atoms: c.atoms.length, generations: c.generations.length, items: c.items.length, state_rows: c.state_rows.length, receipts: c.receipts.length }));
  } else if (mode === 'preflight') {
    const bad = preflight(JSON.parse(readFileSync(rest[0], 'utf8')));
    console.log(JSON.stringify({ preflight: bad.length ? 'BLOCKED' : 'CLEAN', blocking: bad.slice(0, 20), blocking_count: bad.length }));
    process.exit(bad.length ? 1 : 0);
  } else throw Error('mode: capture | preflight');
}
