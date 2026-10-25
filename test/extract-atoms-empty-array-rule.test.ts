/**
 * extract_atoms prompt — explicit zero-yield rule.
 *
 * Metadata-only pages (connector rows, status dumps, boilerplate) gave the
 * model nothing to extract, and the prompt never said what to do then. Local
 * and smaller models responded by inventing 1-3 atoms or by explaining in
 * prose; prose parses as `no JSON array in response`, which is a counted
 * deterministic failure, so the page burned every retry and was tombstoned
 * for no reason. The prompt tells the model to output exactly `{"atoms":[]}` for a
 * content-free transcript, which the parser already treats as an honest
 * zero-yield (ok: true, atoms: []).
 *
 * Pins: the system prompt sent to the model carries the rule. Asserted on
 * the prompt actually sent through the chat seam, not on source text.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseAtomsOutcome } from '../src/core/cycle/extract-atoms.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from './helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

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

function okChatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  } as ChatResult;
}

describe('extract_atoms prompt — content-free transcript rule', () => {
  test('the system prompt requests an empty atoms envelope when nothing is extractable', async () => {
    let capturedSystem = '';
    let capturedMaxTokens = 0;
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'documents/connector-row', content: 'status: open\nowner: alice-example\n', contentHash: 'b'.repeat(16) }],
      _chat: async (opts: ChatOpts) => {
        capturedSystem = String(opts.system ?? '');
        capturedMaxTokens = opts.maxTokens ?? 0;
        return okChatResult('[]');
      },
    });
    expect(capturedSystem.length).toBeGreaterThan(0); // the seam was hit
    // The rule names the zero-yield shape AND forbids the two failure modes
    // (invented atoms, prose).
    expect(capturedSystem).toMatch(/no extractable idea[\s\S]*output exactly \{"atoms":\[\]\}/);
    expect(capturedSystem).toMatch(/never invent an atom/);
    expect(capturedSystem).toMatch(/never explain in prose/);
    // S551 (A1 prompt, replaces the S390 "durable / six months" wording, which pushed the model to
    // widen one incident into a general rule): atoms stay at the transcript's scope and quote it verbatim.
    expect(capturedSystem).toMatch(/THIS TRANSCRIPT ESTABLISHES, stated at\s+the scope the transcript supports/);
    expect(capturedSystem).toContain('One incident stays one incident');
    // A2: open with the specific system; lesson is null or names the same system, never universal advice
    expect(capturedSystem).toContain('Open with the specific system, component or incident');
    expect(capturedSystem).toMatch(/lesson \(null, or one sentence that names the same system or incident/);
    expect(capturedSystem).toMatch(/If no passage supports the claim\s+verbatim, do not output the atom/);
    expect(capturedSystem).toContain('0-8 per transcript, never more than 8');
    expect(capturedMaxTokens).toBe(8192);
  });

  test('[] is an honest zero-yield, not a parse failure (the path the rule steers into)', () => {
    expect(parseAtomsOutcome('{"atoms":[]}')).toEqual({ ok: true, atoms: [] });
    expect(parseAtomsOutcome('[]')).toEqual({ ok: true, atoms: [] });
    // The rule must survive a bracketed preamble too: a model that echoes a
    // `[Source: …]` citation before obeying still yields an honest `[]`.
    expect(parseAtomsOutcome('[Source: x] nothing here.\n[]')).toEqual({ ok: true, atoms: [] });
    // Positive control: the prose the rule prevents IS a failure.
    expect(parseAtomsOutcome('This page has no extractable ideas.')).toEqual({
      ok: false,
      reason: 'no JSON array in response',
    });
  });
});
