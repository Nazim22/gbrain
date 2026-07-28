// S391 — a successful-but-EMPTY transcript extraction must NOT count as a
// processed transcript.
//
// The bug this pins: transcript idempotency is keyed on EXISTING ATOM ROWS.
// A transcript that yields zero atoms leaves no row, so counting it as
// `transcripts_processed` meant the content was never indexed AND never
// rediscovered — a silent, permanent loss. It was caught in production only
// because the brain keeper noticed the coverage gap and hand-ran a fallback
// model roughly hourly for two days.
//
// Pages are deliberately NOT covered by this rule: #2144 tombstones a
// zero-yield page by content hash so it stops being rediscovered, which is
// safe precisely because the page carries that stamp. Transcripts have no
// such stamp, so the correct disposition is a retryable failure.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function reply(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'ollama:test',
    providerId: 'ollama',
  };
}

/** Records every model it was called with, and replies per-call. */
function scriptedChat(replies: string[]) {
  const calls: string[] = [];
  const fn = async (o: ChatOpts): Promise<ChatResult> => {
    calls.push(String(o.model));
    return reply(replies[Math.min(calls.length - 1, replies.length - 1)]);
  };
  return { fn, calls };
}

const TRANSCRIPT = [{ filePath: '/T.txt', content: 'substantive content', contentHash: 'emptyretry123456' }];

describe('S391 — empty transcript extraction is retryable, never silently processed', () => {
  test('persistent empty is a FAILURE, not a processed transcript', async () => {
    const chat = scriptedChat(['[]']); // always empty
    const r = await runPhaseExtractAtoms(engine, {
      _transcripts: TRANSCRIPT,
      _pages: [],
      _chat: chat.fn,
    });

    const d = r.details as Record<string, unknown>;
    // the actual bug: this used to be 1
    expect(d.transcripts_processed).toBe(0);
    expect(d.atoms_extracted).toBe(0);
    expect((d.failures as unknown[]).length).toBe(1);
    expect(JSON.stringify(d.failures)).toContain('empty_extraction');
    expect(r.status).toBe('warn'); // visible, not a clean 'ok'
  });

  test('an empty first attempt is retried', async () => {
    const chat = scriptedChat(['[]', '[]']);
    await runPhaseExtractAtoms(engine, {
      _transcripts: TRANSCRIPT,
      _pages: [],
      _chat: chat.fn,
    });
    expect(chat.calls.length).toBe(2); // one retry, not one-and-done
  });

  test('recovery on retry counts the transcript and writes the atoms', async () => {
    const chat = scriptedChat([
      '[]',
      '[{"title":"recovered-atom","atom_type":"insight","body":"found on retry"}]',
    ]);
    const r = await runPhaseExtractAtoms(engine, {
      _transcripts: TRANSCRIPT,
      _pages: [],
      _chat: chat.fn,
    });

    const d = r.details as Record<string, unknown>;
    expect(d.transcripts_processed).toBe(1);
    expect(d.atoms_extracted).toBe(1);
    expect(d.empty_retry_recoveries).toBe(1);
    expect((d.failures as unknown[]).length).toBe(0);
    expect(r.status).toBe('ok');
  });

  test('the retry uses the configured fallback model when one is set', async () => {
    await engine.setConfig('models.dream.extract_atoms', 'ollama:primary');
    await engine.setConfig('models.dream.extract_atoms_fallback', 'ollama:secondary');

    const chat = scriptedChat([
      '[]',
      '[{"title":"fallback-atom","atom_type":"insight","body":"b"}]',
    ]);
    const r = await runPhaseExtractAtoms(engine, {
      _transcripts: TRANSCRIPT,
      _pages: [],
      _chat: chat.fn,
    });

    expect(chat.calls[0]).toBe('ollama:primary');
    expect(chat.calls[1]).toBe('ollama:secondary'); // the whole point
    const d = r.details as Record<string, unknown>;
    expect(d.fallback_model).toBe('ollama:secondary');
    expect(d.transcripts_processed).toBe(1);
  });

  test('a first-attempt success is NOT retried (no extra model spend)', async () => {
    const chat = scriptedChat(['[{"title":"first-try","atom_type":"insight","body":"b"}]']);
    await runPhaseExtractAtoms(engine, {
      _transcripts: TRANSCRIPT,
      _pages: [],
      _chat: chat.fn,
    });
    expect(chat.calls.length).toBe(1);
  });
});
