/**
 * S551: `cycle.extract_atoms.thinking=off` makes every extraction call ask the
 * route to turn thinking off (`chat({ thinking: 'off' })`); unset leaves the
 * model default. Hermetic: in-memory PGLite, chat stubbed through `_chat`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

const DIMS = 1536;
let engine: PGLiteEngine;
let seen: ChatOpts[] = [];
let n = 0;

async function chat(o: ChatOpts): Promise<ChatResult> {
  seen.push(o);
  return {
    text: '{"atoms":[]}', blocks: [{ type: 'text', text: '' }], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'llama-server:local-model', providerId: 'llama-server',
  };
}

async function runOnce() {
  n++;
  await runPhaseExtractAtoms(engine, {
    _transcripts: [{ filePath: `/fake/session-${n}.txt`, content: `transcript content ${n}`, contentHash: `${n}`.padStart(16, '0') }],
    _pages: [],
    _chat: chat,
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async (args: { values: string[] }) => ({
    embeddings: args.values.map(() => Array.from({ length: DIMS }, () => 0.01)), usage: { tokens: 1 },
  })) as never);
  await engine.setConfig('models.dream.extract_atoms', 'llama-server:local-model');
});
afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine.disconnect(); });
afterEach(async () => { seen = []; await engine.unsetConfig('cycle.extract_atoms.thinking'); });

describe('cycle.extract_atoms.thinking (S551)', () => {
  test("'off' asks every extraction call to turn thinking off", async () => {
    await engine.setConfig('cycle.extract_atoms.thinking', 'off');
    await runOnce();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(o => o.thinking === 'off')).toBe(true);
  });

  test('unset leaves the model default (no thinking option on the call)', async () => {
    await runOnce();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(o => o.thinking === undefined)).toBe(true);
  });
});
