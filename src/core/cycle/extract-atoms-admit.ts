/**
 * extract_atoms admission manifest. When `cycle.extract_atoms.admit_hashes_file` is set, a run admits only items
 * listed as `<hash16>\t<source>` (one per line): `<source>` is the transcript path exactly as discovered, or
 * `page:<slug>`. Binding path + hash keeps two sources with identical bytes distinct, and the hash is the one computed
 * from the bytes read in this run, so an item changed since the manifest was frozen is not admitted.
 * States: key unset = no restriction (today's behaviour); key set to an EMPTY file = admission CLOSED (nothing runs).
 * Fail-closed: a set key whose file is unreadable or has a malformed line admits nothing.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

export const ADMIT_HASHES_KEY = 'cycle.extract_atoms.admit_hashes_file';
export const ADMIT_HASHES_MAX = 10_000;
export const admitKey = (hash16: string, source: string) => `${hash16}\t${source}`;

export function parseAdmitManifest(text: string): Set<string> {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length > ADMIT_HASHES_MAX || lines.some(l => !/^[0-9a-f]{16}\t\S.*$/.test(l))) return new Set();
  return new Set(lines);
}

/** null = no manifest (admit everything); a Set = admit only these `hash16\tsource` keys (empty Set = closed). */
export async function resolveAdmitManifest(engine: BrainEngine): Promise<Set<string> | null> {
  let path: string | null = null;
  // Only a successful read that finds the key unset means "no manifest". A failed lookup admits NOTHING: when the
  // manifest bounds a batch, an unreadable config must never widen it to every item.
  try { path = (await engine.getConfig(ADMIT_HASHES_KEY)) ?? null; }
  catch { console.error(`[extract_atoms] ${ADMIT_HASHES_KEY} lookup failed: admission closed`); return new Set(); }
  if (!path) return null;
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { console.error(`[extract_atoms] ${ADMIT_HASHES_KEY} set but unreadable: admission closed`); return new Set(); }
  const admit = parseAdmitManifest(text);
  console.error(`[extract_atoms] admission manifest: ${admit.size} sources, sha256=${createHash('sha256').update(text).digest('hex')}`);
  return admit;
}
