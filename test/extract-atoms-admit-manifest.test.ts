// Admission manifest (`cycle.extract_atoms.admit_hashes_file`) and atom model provenance.
// Protects: a bounded batch admits exactly its listed (hash16, source) pairs, whichever runner reads the key; an
// empty manifest closes admission; an item whose bytes changed since the manifest was frozen is not admitted; two
// sources with identical bytes stay distinct; unset = today's behaviour. Atoms record the served model and the route.
// Fails when: the filter keys on hash alone, admits on unset/empty/unreadable wrongly, or the provenance fields drop.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { ADMIT_HASHES_KEY } from '../src/core/cycle/extract-atoms-admit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'admit-'));
const body = (n: number) => [`Session ${n}.`, `We chose option ${n} because it is simpler.`].join('\n').padEnd(2400, ' .');
const h = (n: number) => String(n).repeat(16).slice(0, 16);
const transcript = (n: number, path = `/corpus/s${n}.txt`, hash = h(n)) => ({ filePath: path, content: body(n), contentHash: hash + 'f'.repeat(48) });
let calls = 0;
const chat = (served?: string) => async (_o: ChatOpts): Promise<ChatResult> => {
  calls++;
  const text = JSON.stringify([{ title: `Choice ${calls}`, atom_type: 'insight', body: 'The simpler option was chosen.', source_quote: 'because it is simpler' }]);
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'litellm:gpt-6-luna@medium', providerId: 'litellm', ...(served ? { responseModel: served } : {}) } as ChatResult;
};
async function run(items: ReturnType<typeof transcript>[], manifest?: string, served?: string) {
  calls = 0;
  if (manifest === undefined) await engine.unsetConfig?.(ADMIT_HASHES_KEY).catch(() => {});
  else { const p = join(dir, `m-${Math.random()}.txt`); writeFileSync(p, manifest); await engine.setConfig(ADMIT_HASHES_KEY, p); }
  await runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: items, _pages: [], _chat: chat(served), model: 'litellm:gpt-6-luna@medium' } as any);
  return calls;
}

describe('extract_atoms admission manifest', () => {
  test('admits exactly the listed (hash16, path) pairs', async () => {
    const items = [1, 2, 3, 4, 5].map(n => transcript(n));
    expect(await run(items, [1, 3, 5].map(n => `${h(n)}\t/corpus/s${n}.txt`).join('\n') + '\n')).toBe(3);
  });
  test('identical bytes at two paths: only the listed path is admitted', async () => {
    const twins = [transcript(7, '/corpus/a.txt'), transcript(7, '/corpus/b.txt')];
    expect(await run(twins, `${h(7)}\t/corpus/b.txt\n`)).toBe(1);
    // Discriminates path binding: without it, hash dedup keeps the FIRST twin (a.txt).
    const pages = await engine.listPages({ type: 'atom', limit: 10 });
    const atom = (await engine.getPage(pages[0]!.slug, { sourceId: 'default' }))!;
    expect(atom.frontmatter.source_path).toBe('/corpus/b.txt');
  });
  test('an item whose bytes changed since the manifest was frozen is not admitted', async () => {
    expect(await run([transcript(8, '/corpus/s8.txt', h(9))], `${h(8)}\t/corpus/s8.txt\n`)).toBe(0);
  });
  test('an empty manifest closes admission; a malformed one admits nothing', async () => {
    const items = [1, 2].map(n => transcript(n));
    expect(await run(items, '')).toBe(0);
    expect(await run(items, `${h(1)}\n`)).toBe(0); // no source column
  });
  test('unset key keeps today\'s behaviour (all items)', async () => {
    expect(await run([1, 2, 3].map(n => transcript(n)))).toBe(3);
  });
});

describe('extract_atoms atom provenance', () => {
  test('atoms record the served model and the requested route', async () => {
    await run([transcript(4)], undefined, 'gpt-6-luna-2026-10-01');
    const pages = await engine.listPages({ type: 'atom', limit: 10 });
    expect(pages.length).toBe(1);
    const atom = (await engine.getPage(pages[0]!.slug, { sourceId: 'default' }))!;
    expect(atom.frontmatter.extracted_model).toBe('gpt-6-luna-2026-10-01');
    expect(atom.frontmatter.extracted_route).toBeTruthy();
  });
});
