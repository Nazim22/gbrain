/**
 * READ-ONLY inventory of transcript parts for Luna catch-up (DESIGN.md §8b). Uses gbrain's own discovery and the
 * same idempotency predicates as extract_atoms. No model calls, no writes (session is SET TRANSACTION READ ONLY).
 * Usage: DATABASE_URL=... bun inventory.ts <corpusDir> <outDir> [renames.tsv]
 * Writes: inventory.json (per part: path, hash16, class) + missing.manifest (hash16\tpath) + counts.
 * Stage 2 (STAGE2-DESIGN r2 §2): classes are tested in a fixed order and the first match wins; every path test runs on
 * both names of a renamed part (renames.tsv: legacy, dated, ...); a part with any retired atom is never eligible:
 * a rollback's parts stay excluded (r3, Pebble 17:35Z), so there is no readmission. The file-level exclusions
 * (stale single, active session, undatable) are date_parts.py plan's, applied to this tool's missing list.
 */
import postgres from 'postgres';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { discoverTranscripts } from '../../../src/core/cycle/transcript-discovery.ts';
import { claudeCliSelfSessionIds } from '../../../src/core/ai/providers/claude-cli-scratch.ts';

const [corpusDir, outDir, renamesTsv] = process.argv.slice(2);
if (!corpusDir || !outDir) throw Error('usage: inventory.ts <corpusDir> <outDir> [renames.tsv]');
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const parts = discoverTranscripts({ corpusDir, selfCaptureSessionIds: claudeCliSelfSessionIds() })
  .map(d => ({ path: d.filePath, hash16: d.contentHash.slice(0, 16) }));
const hashes = [...new Set(parts.map(p => p.hash16))];
// Both names of a renamed part (§2 identity): legacy <-> dated, from the rename log.
const other = new Map<string, string>();
if (renamesTsv && existsSync(renamesTsv)) for (const line of readFileSync(renamesTsv, 'utf8').split('\n').filter(Boolean)) {
  const [legacy, dated] = line.split('\t'); other.set(legacy!, dated!); other.set(dated!, legacy!);
}
const names = (path: string) => (other.has(path) ? [path, other.get(path)!] : [path]);
const allNames = [...new Set(parts.flatMap(p => names(p.path)))];

const res = await sql.begin('READ ONLY', async tx => {
  const live = await tx`SELECT DISTINCT frontmatter->>'source_hash' AS h FROM pages WHERE type='atom' AND source_id='default' AND deleted_at IS NULL
                        AND COALESCE(frontmatter->>'managed_extraction','') <> 'true' AND frontmatter->>'source_hash' = ANY(${hashes})`;
  const state = await tx`SELECT file_path, content_hash, tombstoned, fail_count, partial_input_chars FROM extract_atoms_transcript_state
                         WHERE source_id='default' AND content_hash = ANY(${hashes})`;
  const byPath = await tx`SELECT DISTINCT frontmatter->>'source_path' AS p, frontmatter->>'source_hash' AS h FROM pages
                          WHERE type='atom' AND source_id='default' AND deleted_at IS NULL AND frontmatter->>'source_path' = ANY(${allNames})`;
  const gens = await tx`SELECT DISTINCT locator FROM derived_generations WHERE source_id='default' AND kind='atom'
                        AND state IN ('live','held') AND locator = ANY(${allNames})`;
  const retired = await tx`SELECT id::text AS id, frontmatter->>'source_hash' AS h, COALESCE(frontmatter->>'retired_by','') AS by FROM pages
                           WHERE type='atom' AND source_id='default' AND deleted_at IS NOT NULL AND frontmatter->>'source_hash' = ANY(${hashes})`;
  const independent = await tx`SELECT count(DISTINCT frontmatter->>'source_path')::int AS n FROM pages WHERE type='atom' AND source_id='default'
                               AND deleted_at IS NULL AND frontmatter->>'source_path' = ANY(${allNames})`;
  return { live, state, retired, byPath, gens, independent };
});
await sql.end();

const liveSet = new Set(res.live.map((r: any) => r.h));
const pathHashes = new Map<string, Set<string | null>>();
for (const r of res.byPath as any[]) { if (!pathHashes.has(r.p)) pathHashes.set(r.p, new Set()); pathHashes.get(r.p)!.add(r.h); }
const genLoc = new Set(res.gens.map((r: any) => r.locator));
const stateBy = new Map(res.state.map((r: any) => [`${r.file_path}\u0000${r.content_hash}`, r]));
const retiredBy = new Map<string, { id: string; by: string }[]>();
for (const r of res.retired as any[]) { if (!retiredBy.has(r.h)) retiredBy.set(r.h, []); retiredBy.get(r.h)!.push({ id: r.id, by: r.by }); }
const OWN = 'luna-batch-rollback';
const rows = parts.map(p => {
  const ns = names(p.path);
  const onPath = ns.flatMap(n => [...(pathHashes.get(n) ?? [])]);
  const st: any = ns.map(n => stateBy.get(`${n}\u0000${p.hash16}`)).find(Boolean);
  const ret = retiredBy.get(p.hash16);
  let cls: string; // §2 precedence: the first match wins
  if (liveSet.has(p.hash16) || onPath.includes(null)) cls = 'extracted'; // own hash, or a legacy atom with no hash on this path
  else if (onPath.length) cls = 'changed-since-extraction'; // live atoms from another version of this path: stage 3
  else if (st?.partial_input_chars != null) cls = 'partial';
  else if (st?.tombstoned && Number(st.fail_count) === 0) cls = 'zero-yield';
  else if (st?.tombstoned) cls = 'tombstoned';
  else if (st) cls = 'state';
  else if (ns.some(n => genLoc.has(n))) cls = 'generation';
  else if (ret && ret.some(r => r.by !== OWN)) cls = 'retired-deliberate';
  else if (ret) cls = 'rolled-back'; // a rollback's parts stay excluded: never eligible again in this stage
  else cls = 'missing';
  return { ...p, class: cls };
});
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const counts: Record<string, number> = {};
for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
const missing = rows.filter(r => r.class === 'missing').sort((a, b) => a.path.localeCompare(b.path));
const manifest = missing.map(r => `${r.hash16}\t${r.path}`).join('\n') + (missing.length ? '\n' : '');
writeFileSync(`${outDir}/inventory.json`, JSON.stringify({ corpusDir, discovered: parts.length, counts, rows }, null, 1), { mode: 0o600 });
writeFileSync(`${outDir}/missing.manifest`, manifest, { mode: 0o600 });
const total = Object.values(counts).reduce((a, b) => a + b, 0);
if (total !== parts.length) throw Error(`classes sum to ${total}, discovered ${parts.length}`);
// Second, independent count: distinct live-atom source paths among these parts' names (= the parts whose path has
// a live atom: extracted-by-path and changed). Printed for the runner to compare, never used to classify.
console.log(JSON.stringify({ discovered: parts.length, unique_hashes: hashes.length, counts, independent_live_paths: res.independent[0].n,
  missing_manifest_sha256: createHash('sha256').update(manifest).digest('hex'),
  samples: Object.fromEntries(Object.keys(counts).map(c => [c, rows.filter(r => r.class === c).slice(0, 5).map(r => r.path.split('/').pop())])) }, null, 1));
