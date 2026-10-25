/**
 * S551: `cycle.extract_atoms.provider_options` (JSON object of provider-option namespaces) rides on every
 * extraction chat call and nowhere else; invalid values are ignored. Hermetic: PGLite, chat via `_chat`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseExtractProviderOptions, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

const DIMS = 1536;
const NO_THINK = { 'llama-server': { chat_template_kwargs: { enable_thinking: false } } };
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
afterEach(async () => { seen = []; await engine.unsetConfig('cycle.extract_atoms.provider_options'); });

describe('cycle.extract_atoms.provider_options (S551)', () => {
  test('a valid object of namespaces is passed on every extraction call', async () => {
    await engine.setConfig('cycle.extract_atoms.provider_options', JSON.stringify(NO_THINK));
    await runOnce();
    expect(seen.length).toBeGreaterThan(0);
    for (const o of seen) expect(o.providerOptions).toEqual(NO_THINK);
  });

  test('unset sends no provider options', async () => {
    await runOnce();
    expect(seen.length).toBeGreaterThan(0);
    for (const o of seen) expect(o.providerOptions).toBeUndefined();
  });

  test('invalid values are ignored, never forwarded', () => {
    for (const bad of ['not json', '[1,2]', '{"llama-server": 1}', '{"a": [1]}', '"x"', '']) {
      expect(parseExtractProviderOptions(bad)).toBeUndefined();
    }
    expect(parseExtractProviderOptions(JSON.stringify(NO_THINK))).toEqual(NO_THINK);
  });
});
