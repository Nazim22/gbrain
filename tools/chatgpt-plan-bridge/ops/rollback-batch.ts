/**
 * Scoped rollback of one manifest batch by exact ids (DESIGN.md §8b, r4). Runners must be paused and admission closed.
 * Usage: DATABASE_URL=... bun rollback-batch.ts plan|apply|verify <before.json> <after.json>
 *  plan   — print the write set (new / changed ids per table) and exit
 *  apply  — one transaction; every statement must affect exactly its id count, else the whole rollback aborts
 *  verify — re-read every id and compare with its expected post-rollback state: DONE | NOT_APPLIED | MIXED
 * new atoms + receipts → soft-retired (retired_by: luna-batch-rollback, retired_at: the purge's 30-day hold);
 * changed existing atoms (e.g. a resurrected rollback-owned slug) → restored to their captured before-state;
 * new generations, items and transcript-state rows → deleted by id; a changed existing generation/state row → abort.
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { OWN, type Capture } from './writeset.ts';

const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const atomState = (a: Capture['atoms'][number]) => sha([a.deleted_at, a.content_hash, a.frontmatter, a.compiled_truth]);

export function writeSet(before: Capture, after: Capture) {
  if (before.manifest_sha256 !== after.manifest_sha256) throw Error('MANIFEST-MISMATCH');
  const b = new Map(before.atoms.map(a => [a.id, a]));
  const newAtoms = after.atoms.filter(a => !b.has(a.id)).map(a => a.id);
  const changedAtoms = after.atoms.filter(a => b.has(a.id) && atomState(a) !== atomState(b.get(a.id)!)).map(a => a.id);
  const bg = new Set(before.generations.map(g => g.id));
  const changedGens = after.generations.filter(g => bg.has(g.id) && sha(g) !== sha(before.generations.find(x => x.id === g.id)));
  const newGens = after.generations.filter(g => !bg.has(g.id)).map(g => g.id);
  const newItems = after.items.filter(i => newGens.includes(i.generation_id)).length;
  const bs = new Set(before.state_rows.map(s => `${s.file_path}\u0000${s.content_hash}`));
  const newState = after.state_rows.filter(s => !bs.has(`${s.file_path}\u0000${s.content_hash}`));
  const changedState = after.state_rows.filter(s => bs.has(`${s.file_path}\u0000${s.content_hash}`) && sha(s) !== sha(before.state_rows.find(x => x.file_path === s.file_path && x.content_hash === s.content_hash)));
  const br = new Map(before.receipts.map(r => [r.id, r]));
  const newReceipts = after.receipts.filter(r => !br.has(r.id)).map(r => r.id);
  const changedReceipts = after.receipts.filter(r => br.has(r.id) && atomState(r as any) !== atomState(br.get(r.id) as any)).map(r => r.id);
  return { newAtoms, changedAtoms, newGens, newItems, newState, newReceipts, changedReceipts, changedGens: changedGens.map(g => g.id), changedState: changedState.length, before: b, beforeReceipts: br };
}

async function apply(sql: postgres.Sql, ws: ReturnType<typeof writeSet>) {
  if (ws.changedGens.length || ws.changedState) throw Error(`ABORT: changed existing generation/state rows (${ws.changedGens.length}/${ws.changedState}) — stop for review`);
  await sql.begin(async tx => {
    const exact = (n: number, want: number, what: string) => { if (n !== want) throw Error(`ABORT: ${what} affected ${n}, expected ${want}`); };
    if (ws.newAtoms.length) exact((await tx`UPDATE pages SET deleted_at = now(), frontmatter = frontmatter || jsonb_build_object('retired_by', ${OWN}::text, 'retired_at', now()::text)
      WHERE id = ANY(${ws.newAtoms}) AND type='atom' AND deleted_at IS NULL`).count, ws.newAtoms.length, 'retire new atoms');
    for (const id of ws.changedAtoms) {
      const a = ws.before.get(id)!;
      exact((await tx`UPDATE pages SET deleted_at = ${a.deleted_at}, content_hash = ${a.content_hash}, frontmatter = ${tx.json(a.frontmatter)}, compiled_truth = ${a.compiled_truth}, updated_at = now()
        WHERE id = ${id} AND type='atom'`).count, 1, `restore atom ${id}`);
    }
    if (ws.newGens.length) {
      exact((await tx`DELETE FROM derived_generation_items WHERE generation_id = ANY(${ws.newGens})`).count, ws.newItems, 'delete generation items');
      exact((await tx`DELETE FROM derived_generations WHERE id = ANY(${ws.newGens}) AND kind='atom'`).count, ws.newGens.length, 'delete generations');
    }
    for (const s of ws.newState) exact((await tx`DELETE FROM extract_atoms_transcript_state WHERE source_id='default' AND file_path=${s.file_path} AND content_hash=${s.content_hash}`).count, 1, `delete state ${s.file_path}`);
    if (ws.newReceipts.length) exact((await tx`UPDATE pages SET deleted_at = now(), frontmatter = frontmatter || jsonb_build_object('retired_by', ${OWN}::text, 'retired_at', now()::text)
      WHERE id = ANY(${ws.newReceipts}) AND type='extract_receipt' AND deleted_at IS NULL`).count, ws.newReceipts.length, 'retire receipts');
    for (const id of ws.changedReceipts) {
      const r = ws.beforeReceipts.get(id)!;
      exact((await tx`UPDATE pages SET deleted_at = ${r.deleted_at}, content_hash = ${r.content_hash}, frontmatter = ${tx.json(r.frontmatter)}, compiled_truth = ${r.compiled_truth}, updated_at = now()
        WHERE id = ${id} AND type='extract_receipt'`).count, 1, `restore receipt ${id}`);
    }
  });
}

/** Re-read every id: DONE = all in post-rollback state; NOT_APPLIED = none; MIXED = some (stop). */
async function verify(sql: postgres.Sql, ws: ReturnType<typeof writeSet>, before: Capture) {
  const checks: boolean[] = [];
  const atoms = ws.newAtoms.length || ws.changedAtoms.length ? await sql`SELECT id, deleted_at, content_hash, frontmatter, compiled_truth FROM pages WHERE id = ANY(${[...ws.newAtoms, ...ws.changedAtoms]})` : [];
  const byId = new Map(atoms.map((a: any) => [Number(a.id), a]));
  for (const id of ws.newAtoms) { const a: any = byId.get(id); checks.push(!!a && !!a.deleted_at && a.frontmatter?.retired_by === OWN); }
  for (const id of ws.changedAtoms) {
    const a: any = byId.get(id), want = ws.before.get(id)!;
    checks.push(!!a && sha([a.deleted_at ? new Date(a.deleted_at).toISOString() : null, a.content_hash, a.frontmatter, a.compiled_truth]) === atomState(want));
  }
  const gens = ws.newGens.length ? await sql`SELECT id FROM derived_generations WHERE id = ANY(${ws.newGens})` : [];
  checks.push(...ws.newGens.map(id => !gens.some((g: any) => Number(g.id) === id)));
  for (const s of ws.newState) checks.push((await sql`SELECT 1 FROM extract_atoms_transcript_state WHERE source_id='default' AND file_path=${s.file_path} AND content_hash=${s.content_hash}`).length === 0);
  const rec = ws.newReceipts.length || ws.changedReceipts.length ? await sql`SELECT id, deleted_at, content_hash, frontmatter, compiled_truth FROM pages WHERE id = ANY(${[...ws.newReceipts, ...ws.changedReceipts]})` : [];
  const recBy = new Map(rec.map((r: any) => [Number(r.id), r]));
  for (const id of ws.newReceipts) { const r: any = recBy.get(id); checks.push(!!r && !!r.deleted_at && r.frontmatter?.retired_by === OWN); }
  for (const id of ws.changedReceipts) {
    const r: any = recBy.get(id), want = ws.beforeReceipts.get(id)!;
    checks.push(!!r && sha([r.deleted_at ? new Date(r.deleted_at).toISOString() : null, r.content_hash, r.frontmatter, r.compiled_truth]) === atomState(want as any));
  }
  const ok = checks.filter(Boolean).length;
  return { verdict: checks.length === 0 || ok === checks.length ? 'DONE' : ok === 0 ? 'NOT_APPLIED' : 'MIXED', ok, total: checks.length };
}

if (import.meta.main) {
  const [mode, beforePath, afterPath] = process.argv.slice(2);
  const before: Capture = JSON.parse(readFileSync(beforePath, 'utf8')), after: Capture = JSON.parse(readFileSync(afterPath, 'utf8'));
  const ws = writeSet(before, after);
  const summary = { new_atoms: ws.newAtoms.length, changed_atoms: ws.changedAtoms.length, new_generations: ws.newGens.length, new_items: ws.newItems, new_state_rows: ws.newState.length, new_receipts: ws.newReceipts.length, changed_receipts: ws.changedReceipts.length, changed_generations: ws.changedGens.length, changed_state_rows: ws.changedState };
  if (mode === 'plan') { console.log(JSON.stringify({ plan: summary, new_atom_ids: ws.newAtoms, changed_atom_ids: ws.changedAtoms })); process.exit(0); }
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    if (mode === 'apply') { await apply(sql, ws); console.log(JSON.stringify({ applied: summary, ...(await verify(sql, ws, before)) })); }
    else if (mode === 'verify') console.log(JSON.stringify(await verify(sql, ws, before)));
    else throw Error('mode: plan | apply | verify');
  } finally { await sql.end(); }
}
