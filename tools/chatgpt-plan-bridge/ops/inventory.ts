/**
 * READ-ONLY inventory of transcript parts for Luna catch-up (DESIGN.md §8b). Uses gbrain's own discovery and the
 * same idempotency predicates as extract_atoms. No model calls, no writes (session is SET TRANSACTION READ ONLY).
 * Usage: DATABASE_URL=... bun inventory.ts <corpusDir> <outDir>
 * Writes: inventory.json (per part: path, hash16, class) + missing.manifest (hash16\tpath) + counts.
 */
import postgres from 'postgres';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { discoverTranscripts } from '../../../src/core/cycle/transcript-discovery.ts';
import { claudeCliSelfSessionIds } from '../../../src/core/ai/providers/claude-cli-scratch.ts';

const [corpusDir, outDir] = process.argv.slice(2);
if (!corpusDir || !outDir) throw Error('usage: inventory.ts <corpusDir> <outDir>');
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const parts = discoverTranscripts({ corpusDir, selfCaptureSessionIds: claudeCliSelfSessionIds() })
  .map(d => ({ path: d.filePath, hash16: d.contentHash.slice(0, 16) }));
const hashes = [...new Set(parts.map(p => p.hash16))];

const res = await sql.begin('READ ONLY', async tx => {
  const live = await tx`SELECT DISTINCT frontmatter->>'source_hash' AS h FROM pages WHERE type='atom' AND source_id='default' AND deleted_at IS NULL
                        AND COALESCE(frontmatter->>'managed_extraction','') <> 'true' AND frontmatter->>'source_hash' = ANY(${hashes})`;
  const state = await tx`SELECT file_path, content_hash, tombstoned, fail_count, partial_input_chars FROM extract_atoms_transcript_state
                         WHERE source_id='default' AND content_hash = ANY(${hashes})`;
  const byPath = await tx`SELECT DISTINCT frontmatter->>'source_path' AS p FROM pages WHERE type='atom' AND source_id='default' AND deleted_at IS NULL
                          AND frontmatter->>'source_path' = ANY(${parts.map(p => p.path)})`;
  const retired = await tx`SELECT frontmatter->>'source_hash' AS h, COALESCE(frontmatter->>'retired_by','') AS by FROM pages
                           WHERE type='atom' AND source_id='default' AND deleted_at IS NOT NULL AND frontmatter->>'source_hash' = ANY(${hashes})`;
  return { live, state, retired, byPath };
});
await sql.end();

const liveSet = new Set(res.live.map((r: any) => r.h));
const livePath = new Set(res.byPath.map((r: any) => r.p));
const stateBy = new Map(res.state.map((r: any) => [`${r.file_path}\u0000${r.content_hash}`, r]));
const retiredBy = new Map<string, Set<string>>();
for (const r of res.retired as any[]) { if (!retiredBy.has(r.h)) retiredBy.set(r.h, new Set()); retiredBy.get(r.h)!.add(r.by); }
const OWN = 'luna-batch-rollback';
const rows = parts.map(p => {
  let cls: string;
  const st: any = stateBy.get(`${p.path}\u0000${p.hash16}`);
  const ret = retiredBy.get(p.hash16);
  if (liveSet.has(p.hash16)) cls = 'extracted';
  else if (st?.partial_input_chars != null) cls = 'partial';
  else if (st?.tombstoned && Number(st.fail_count) === 0) cls = 'zero-yield';
  else if (st?.tombstoned) cls = 'tombstoned';
  else if (livePath.has(p.path)) cls = 'changed-since-extraction'; // live atoms from an older version of this path: replacement (stage 3), not catch-up
  else if (ret && [...ret].some(b => b !== OWN)) cls = 'retired-deliberate';
  else if (ret) cls = 'missing-after-rollback';
  else cls = 'missing';
  return { ...p, class: cls };
});
// Held generations are checked by the phase itself (heldForInput) and only skip; listed here as not inspected.
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const counts: Record<string, number> = {};
for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
const missing = rows.filter(r => r.class === 'missing' || r.class === 'missing-after-rollback').sort((a, b) => a.path.localeCompare(b.path));
const manifest = missing.map(r => `${r.hash16}\t${r.path}`).join('\n') + (missing.length ? '\n' : '');
writeFileSync(`${outDir}/inventory.json`, JSON.stringify({ corpusDir, discovered: parts.length, counts, rows }, null, 1), { mode: 0o600 });
writeFileSync(`${outDir}/missing.manifest`, manifest, { mode: 0o600 });
console.log(JSON.stringify({ discovered: parts.length, unique_hashes: hashes.length, counts, missing_manifest_sha256: createHash('sha256').update(manifest).digest('hex'),
  samples: Object.fromEntries(Object.keys(counts).map(c => [c, rows.filter(r => r.class === c).slice(0, 5).map(r => r.path.split('/').pop())])) }, null, 1));
