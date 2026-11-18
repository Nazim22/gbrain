/**
 * S603 real path, no network: gbrain's own gateway `chat()` → `litellm:` recipe → the Luna bridge's real handler
 * (tools/chatgpt-plan-bridge/bridge.ts) on a loopback port. The error gbrain receives is captured as-is and then fed
 * to the real extract_atoms worker, so classification and the bounded tombstone are proven on the bridge's actual reply.
 *  - a leak-gate refusal (400 content block) strikes the transcript, tombstones it at MAX_DETERMINISTIC_FAILURES,
 *    and the next run makes no chat call;
 *  - a scanner failure (503 leak_gate_unavailable + latch) is transient: no strike row, no tombstone.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms, MAX_DETERMINISTIC_FAILURES } from '../src/core/cycle/extract-atoms.ts';
import { providerContentBlockReason } from '../src/core/ai/errors.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { makeHandler, type Config } from '../tools/chatgpt-plan-bridge/bridge.ts';
import { Limits } from '../tools/chatgpt-plan-bridge/limits.ts';

// Isolation: gbrain's config file can name a provider base URL (a live host has the real bridge there). A scratch
// GBRAIN_HOME makes the gateway use LITELLM_BASE_URL below, and `hits` proves every request reached this stub.
process.env.GBRAIN_HOME = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 's603-gbrain-home-'));
const SECRET = 'c'.repeat(48);
let hits = 0;
let engine: PGLiteEngine;
let handle: (r: Request) => Promise<Response>;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => { hits++; return handle(req); } });

function bridge(scan: (t: string) => Promise<any>) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 's603-path-'));
  const cfg: Config = { port: 0, caller_secret_file: '', state_dir: dir, auth_dir: '', routes: { 'gpt-6-luna': { model: 'gpt-6-luna', effort: 'medium', max_output_chars: 64_000 } },
    ceilings: { per_hour: 100, per_day: 100, concurrency: 2 }, max_body_bytes: 262_144, upstream: { connect_ms: 1000, request_ms: 1000 }, leak: {} as any };
  const sent: unknown[] = [];
  handle = makeHandler(cfg, { callerSecret: Buffer.from(SECRET), limits: new Limits(join(dir, 'counters.json'), cfg.ceilings), accessToken: async () => 'stub', scan,
    mask: async () => ({ unmaskable: 'test' }), upstream: async b => { sent.push(b); throw Error('upstream must not be reached'); } });
  return sent;
}

async function gbrainCallError(): Promise<unknown> {
  const { chat } = await import('../src/core/ai/gateway.ts');
  const { atomsPrompt, ATOMS_RESPONSE_SCHEMA } = await import('../src/core/cycle/extract-atoms.ts') as any;
  try {
    await chat({ model: 'litellm:gpt-6-luna', ...atomsPrompt(true, 'session-s603.part1.txt', 'user: a line.\nassistant: noted.'), maxTokens: 8192, responseSchema: ATOMS_RESPONSE_SCHEMA });
  } catch (e) { return e; }
  throw Error('expected the bridge to refuse');
}

async function stateRow(filePath: string, hash: string) {
  const rows = await engine.executeRaw<{ fail_count: number | string; tombstoned: boolean | string }>(
    `SELECT fail_count, tombstoned FROM extract_atoms_transcript_state WHERE source_id = 'default' AND file_path = $1 AND content_hash = $2`, [filePath, hash]);
  return rows[0] && { fail_count: Number(rows[0].fail_count), tombstoned: rows[0].tombstoned === true || rows[0].tombstoned === 't' };
}

// Captured through the real gateway BEFORE an in-process engine connects: once an embedded PGLite engine is up, unscoped
// gateway calls use a separate state that ignores configureGateway(), and the request would go to the recipe default.
let refusal: { err: unknown; hits: number; sent: number };
let scannerDown: { err: unknown; hits: number; sent: number };
async function capture(scan: (t: string) => Promise<any>) {
  const sent = bridge(scan); const before = hits; const err = await gbrainCallError();
  return { err, hits: hits - before, sent: sent.length };
}
beforeAll(async () => {
  process.env.LITELLM_API_KEY = SECRET;
  // The test preload pins a gateway config, so configure explicitly: the litellm recipe points at this stub bridge.
  const { configureGateway } = await import('../src/core/ai/gateway.ts');
  const { buildGatewayConfig } = await import('../src/core/ai/build-gateway-config.ts');
  configureGateway(buildGatewayConfig({ engine: 'pglite', provider_base_urls: { litellm: `http://127.0.0.1:${server.port}/v1` } } as any));
  refusal = await capture(async () => ({ clean: false, detector: 'redactor', rules: ['2'] }));
  scannerDown = await capture(async () => { throw Error('scanner exploded'); });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 60000);
afterAll(async () => {
  server.stop(true); await engine.disconnect();
  (await import('../src/core/ai/gateway.ts')).resetGateway();
});
beforeEach(async () => { await resetPgliteState(engine); });

const FILE = '/corpus/session-s603.part1.txt', HASH = 'd'.repeat(16);
const item = { filePath: FILE, content: 'transcript prose body', contentHash: HASH };

describe('S603 bridge leak refusal through gbrain', () => {
  test('a leak-gate refusal is a content block: 3 strikes, tombstone, then no more calls', async () => {
    const { err } = refusal;
    expect(refusal.hits).toBe(1); expect(refusal.sent).toBe(0);   // one request reached the stub bridge (a 400 is not retried); nothing went upstream
    expect(providerContentBlockReason(err)).toBe('content_policy_violation');

    const opts = { sourceId: 'default', _pages: [], _transcripts: [item], _chat: async (_o: ChatOpts): Promise<ChatResult> => { throw err; } };
    for (let n = 1; n <= MAX_DETERMINISTIC_FAILURES; n++) {
      const r = await runPhaseExtractAtoms(engine, opts);
      expect((await stateRow(FILE, HASH))?.fail_count).toBe(n);
      expect(r.details.tombstoned_transcripts).toEqual(n === MAX_DETERMINISTIC_FAILURES ? [FILE] : []);
    }
    expect((await stateRow(FILE, HASH))?.tombstoned).toBe(true);
    let calls = 0;
    await runPhaseExtractAtoms(engine, { ...opts, _chat: async (_o: ChatOpts): Promise<ChatResult> => { calls++; throw err; } });
    expect(calls).toBe(0);
  }, 60000);

  test('control: a scanner failure (503 + latch) is transient: no strike row, no tombstone', async () => {
    const { err } = scannerDown;
    expect(scannerDown.hits).toBeGreaterThan(0); expect(scannerDown.sent).toBe(0);
    expect(providerContentBlockReason(err)).toBeUndefined();
    const r = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _transcripts: [item], _chat: async (_o: ChatOpts): Promise<ChatResult> => { throw err; } });
    expect(await stateRow(FILE, HASH)).toBeUndefined();
    expect(r.details.tombstoned_transcripts ?? []).toEqual([]);
  }, 60000);
});
