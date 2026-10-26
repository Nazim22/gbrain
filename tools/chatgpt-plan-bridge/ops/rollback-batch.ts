/**
 * Scoped rollback of one manifest batch by exact ids (DESIGN.md §8b, r4). Runners must be paused and admission closed.
 * Usage: DATABASE_URL=... bun rollback-batch.ts plan|apply|verify <before.json> <after.json>
 *  plan   — print the write set (new / changed ids per table)
 *  apply  — one transaction: lock every row, require it to still equal its captured AFTER state, then mutate; every
 *           statement must affect exactly its id count; any surprise aborts the whole transaction
 *  verify — compare EVERY row against BOTH expected states: all ROLLED-BACK = DONE; all still AFTER = NOT_APPLIED
 *           (safe to apply); anything else (a mix, or a row in neither state) = STOP
 * new atoms + receipts → soft-retired (retired_by luna-batch-rollback, retired_at = the purge's 30-day hold);
 * changed existing atoms + receipts → restored to their captured BEFORE state;
 * new generations / items / transcript-state rows → deleted; a changed existing generation or state row → abort.
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { OWN, type Capture } from './writeset.ts';

type Row = { id: number; deleted_at: string | null; content_hash: string | null; frontmatter: any; compiled_truth: string };
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const pageState = (r: Row) => sha([iso(r.deleted_at), r.content_hash, r.frontmatter, r.compiled_truth]);
const stripRetire = (fm: any) => { const { retired_by: _a, retired_at: _b, ...rest } = fm ?? {}; return rest; };
/** A new row is rolled back when it is deleted, carries our retirement mark, and is otherwise the AFTER content. */
const isRetiredFrom = (cur: Row, after: Row) => !!cur.deleted_at && cur.frontmatter?.retired_by === OWN
  && sha([cur.content_hash, stripRetire(cur.frontmatter), cur.compiled_truth]) === sha([after.content_hash, stripRetire(after.frontmatter), after.compiled_truth]);

export function writeSet(before: Capture, after: Capture) {
  if (before.manifest_sha256 !== after.manifest_sha256) throw Error('MANIFEST-MISMATCH');
  if (JSON.stringify(before.receipt_families) !== JSON.stringify(after.receipt_families)) throw Error('RECEIPT-FAMILIES-MISMATCH: capture AFTER with --like <before>');
  const bA = new Map(before.atoms.map(a => [a.id, a as Row])), aA = new Map(after.atoms.map(a => [a.id, a as Row]));
  const bR = new Map(before.receipts.map(r => [r.id, r as Row])), aR = new Map(after.receipts.map(r => [r.id, r as Row]));
  for (const id of bA.keys()) if (!aA.has(id)) throw Error(`ABORT: atom ${id} vanished during the run`);
  for (const id of bR.keys()) if (!aR.has(id)) throw Error(`ABORT: receipt ${id} vanished during the run`);
  const newAtoms = [...aA.keys()].filter(id => !bA.has(id));
  const changedAtoms = [...aA.keys()].filter(id => bA.has(id) && pageState(aA.get(id)!) !== pageState(bA.get(id)!));
  const newReceipts = [...aR.keys()].filter(id => !bR.has(id));
  const changedReceipts = [...aR.keys()].filter(id => bR.has(id) && pageState(aR.get(id)!) !== pageState(bR.get(id)!));
  const bg = new Map(before.generations.map(g => [g.id, g]));
  const changedGens = after.generations.filter(g => bg.has(g.id) && sha(g) !== sha(bg.get(g.id))).map(g => g.id);
  const newGens = after.generations.filter(g => !bg.has(g.id)).map(g => g.id);
  const newItems = after.items.filter(i => newGens.includes(i.generation_id)).length;
  const sk = (s: { file_path: string; content_hash: string }) => `${s.file_path}\u0000${s.content_hash}`;
  const bs = new Map(before.state_rows.map(s => [sk(s), s]));
  const newState = after.state_rows.filter(s => !bs.has(sk(s)));
  const changedState = after.state_rows.filter(s => bs.has(sk(s)) && sha(s) !== sha(bs.get(sk(s)))).length;
  return { newAtoms, changedAtoms, newReceipts, changedReceipts, newGens, newItems, newState, changedGens, changedState, bA, aA, bR, aR };
}
type WS = ReturnType<typeof writeSet>;

async function apply(sql: postgres.Sql, ws: WS) {
  if (ws.changedGens.length || ws.changedState) throw Error(`ABORT: changed existing generation/state rows (${ws.changedGens.length}/${ws.changedState}) — stop for review`);
  await sql.begin(async tx => {
    const exact = (n: number, want: number, what: string) => { if (n !== want) throw Error(`ABORT: ${what} affected ${n}, expected ${want}`); };
    // Guard: every page row we will touch must still be exactly its captured AFTER state (locked for the transaction).
    const pageIds = [...ws.newAtoms, ...ws.changedAtoms, ...ws.newReceipts, ...ws.changedReceipts];
    const cur = pageIds.length ? await tx`SELECT id, deleted_at, content_hash, frontmatter, compiled_truth FROM pages WHERE id = ANY(${pageIds}) FOR UPDATE` : [];
    const curBy = new Map(cur.map((r: any) => [Number(r.id), r as Row]));
    for (const id of pageIds) {
      const want = ws.aA.get(id) ?? ws.aR.get(id)!; const c = curBy.get(id);
      if (!c || pageState(c) !== pageState(want)) throw Error(`ABORT: page ${id} changed since the AFTER capture — stop for review`);
    }
    const gensNow = ws.newGens.length ? await tx`SELECT id FROM derived_generations WHERE id = ANY(${ws.newGens}) FOR UPDATE` : [];
    exact(gensNow.length, ws.newGens.length, 'lock new generations');

    const retire = async (ids: number[], type: string, what: string) => {
      if (ids.length) exact((await tx`UPDATE pages SET deleted_at = now(), frontmatter = frontmatter || jsonb_build_object('retired_by', ${OWN}::text, 'retired_at', now()::text)
        WHERE id = ANY(${ids}) AND type = ${type} AND deleted_at IS NULL`).count, ids.length, what);
    };
    const restore = async (ids: number[], before: Map<number, Row>, type: string) => {
      for (const id of ids) { const b = before.get(id)!;
        exact((await tx`UPDATE pages SET deleted_at = ${b.deleted_at}, content_hash = ${b.content_hash}, frontmatter = ${tx.json(b.frontmatter)}, compiled_truth = ${b.compiled_truth}, updated_at = now()
          WHERE id = ${id} AND type = ${type}`).count, 1, `restore ${type} ${id}`); }
    };
    await retire(ws.newAtoms, 'atom', 'retire new atoms');
    await restore(ws.changedAtoms, ws.bA, 'atom');
    if (ws.newGens.length) {
      exact((await tx`DELETE FROM derived_generation_items WHERE generation_id = ANY(${ws.newGens})`).count, ws.newItems, 'delete generation items');
      exact((await tx`DELETE FROM derived_generations WHERE id = ANY(${ws.newGens}) AND kind='atom'`).count, ws.newGens.length, 'delete generations');
    }
    for (const s of ws.newState) exact((await tx`DELETE FROM extract_atoms_transcript_state WHERE source_id='default' AND file_path=${s.file_path} AND content_hash=${s.content_hash}`).count, 1, `delete state ${s.file_path}`);
    await retire(ws.newReceipts, 'extract_receipt', 'retire new receipts');
    await restore(ws.changedReceipts, ws.bR, 'extract_receipt');
  });
}

/** Every row is judged against BOTH expected states. */
async function verify(sql: postgres.Sql, ws: WS) {
  const pageIds = [...ws.newAtoms, ...ws.changedAtoms, ...ws.newReceipts, ...ws.changedReceipts];
  const cur = pageIds.length ? await sql`SELECT id, deleted_at, content_hash, frontmatter, compiled_truth FROM pages WHERE id = ANY(${pageIds})` : [];
  const curBy = new Map(cur.map((r: any) => [Number(r.id), r as Row]));
  const verdicts: Array<'rolled' | 'after' | 'neither'> = [];
  const judge = (rolled: boolean, still: boolean) => verdicts.push(rolled ? 'rolled' : still ? 'after' : 'neither');
  for (const id of [...ws.newAtoms, ...ws.newReceipts]) { const c = curBy.get(id), a = (ws.aA.get(id) ?? ws.aR.get(id))!;
    judge(!!c && isRetiredFrom(c, a), !!c && pageState(c) === pageState(a)); }
  for (const id of [...ws.changedAtoms, ...ws.changedReceipts]) { const c = curBy.get(id), a = (ws.aA.get(id) ?? ws.aR.get(id))!, b = (ws.bA.get(id) ?? ws.bR.get(id))!;
    judge(!!c && pageState(c) === pageState(b), !!c && pageState(c) === pageState(a)); }
  const gens = ws.newGens.length ? await sql`SELECT id FROM derived_generations WHERE id = ANY(${ws.newGens})` : [];
  const items = ws.newGens.length ? (await sql`SELECT count(*)::int AS n FROM derived_generation_items WHERE generation_id = ANY(${ws.newGens})`)[0].n : 0;
  for (const id of ws.newGens) { const present = gens.some((g: any) => Number(g.id) === id); judge(!present, present); }
  if (ws.newGens.length) judge(items === 0, items === ws.newItems);
  for (const s of ws.newState) { const n = (await sql`SELECT count(*)::int AS n FROM extract_atoms_transcript_state WHERE source_id='default' AND file_path=${s.file_path} AND content_hash=${s.content_hash}`)[0].n; judge(n === 0, n === 1); }
  const count = (k: string) => verdicts.filter(v => v === k).length;
  const verdict = verdicts.length === 0 || count('rolled') === verdicts.length ? 'DONE' : count('after') === verdicts.length ? 'NOT_APPLIED' : 'STOP';
  return { verdict, rolled_back: count('rolled'), still_after: count('after'), neither: count('neither'), total: verdicts.length };
}

if (import.meta.main) {
  const [mode, beforePath, afterPath] = process.argv.slice(2);
  const before: Capture = JSON.parse(readFileSync(beforePath, 'utf8')), after: Capture = JSON.parse(readFileSync(afterPath, 'utf8'));
  const ws = writeSet(before, after);
  const summary = { new_atoms: ws.newAtoms.length, changed_atoms: ws.changedAtoms.length, new_receipts: ws.newReceipts.length, changed_receipts: ws.changedReceipts.length,
    new_generations: ws.newGens.length, new_items: ws.newItems, new_state_rows: ws.newState.length, changed_generations: ws.changedGens.length, changed_state_rows: ws.changedState };
  if (mode === 'plan') { console.log(JSON.stringify({ plan: summary, new_atom_ids: ws.newAtoms, changed_atom_ids: ws.changedAtoms, receipt_ids: [...ws.newReceipts, ...ws.changedReceipts] })); process.exit(0); }
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    if (mode === 'apply') {
      const pre = await verify(sql, ws);
      if (pre.verdict === 'DONE' && pre.total > 0) { console.log(JSON.stringify({ applied: 'already', ...pre })); }
      else if (pre.verdict !== 'NOT_APPLIED' && pre.total > 0) { console.log(JSON.stringify({ refused: 'state is neither AFTER nor ROLLED-BACK', ...pre })); process.exitCode = 1; }
      else { await apply(sql, ws); console.log(JSON.stringify({ applied: summary, ...(await verify(sql, ws)) })); }
    } else if (mode === 'verify') console.log(JSON.stringify(await verify(sql, ws)));
    else throw Error('mode: plan | apply | verify');
  } finally { await sql.end(); }
}
