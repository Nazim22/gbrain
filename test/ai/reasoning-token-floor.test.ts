// Pins the output-token floor for locally-served reasoning models.
//
// Gemma 4 QAT (llama-server) emits `reasoning_content` BEFORE any `content`,
// spending ~60-90 tokens thinking even on a one-word classification. Callers
// that budgeted for a NON-reasoning model therefore get an empty string.
//
// Verified live 2026-08-01 against the running server — the search intent
// classifier's exact call (`maxTokens: 16`, "reply with one word"):
//
//   content        : ''
//   reasoning      : '*   Query: "what did I decide about the store PC'
//   finish_reason  : 'length'
//
// `parseModality('')` then fails open to the fallback, so `intentWeighting`
// (enabled in ALL three search modes) had been silently inert since cognition
// moved local — not erroring, not logging, just never classifying. The whole
// failure is invisible: a fail-open path plus an empty string looks identical
// to a working classifier that happened to pick the default.

import { describe, test, expect } from 'bun:test';
import { flooredMaxOutputTokens } from '../../src/core/ai/gateway.ts';

const FLOOR = 512;

describe('reasoning-model output floor', () => {
  test('THE BUG: a 16-token classifier budget is raised above the thinking cost', () => {
    // llm-intent.ts asks for exactly this.
    expect(flooredMaxOutputTokens('llama-server:gemma-4-12b-qat', 16)).toBe(FLOOR);
  });

  test('covers every locally-served provider, not just the one we hit', () => {
    for (const m of [
      'llama-server:gemma-4-12b-qat',
      'ollama:qwen3-30b',
      'lmstudio:whatever',
      'local:foo',
      'vllm:bar',
    ]) {
      expect(flooredMaxOutputTokens(m, 16)).toBe(FLOOR);
    }
  });

  test('the other starved callers clear the floor too', () => {
    // voice-gate 100, facts/classify 200, calibration-profile 200, skillopt 200
    for (const requested of [100, 200]) {
      expect(flooredMaxOutputTokens('llama-server:gemma-4-12b-qat', requested)).toBe(FLOOR);
    }
  });

  test('a caller asking for MORE than the floor is never reduced', () => {
    // extract_atoms asks 4096 — a floor must not become a ceiling.
    expect(flooredMaxOutputTokens('llama-server:gemma-4-12b-qat', 4096)).toBe(4096);
    expect(flooredMaxOutputTokens('llama-server:gemma-4-12b-qat', 32000)).toBe(32000);
  });

  test('paid cloud models are untouched — this must not inflate metered spend', () => {
    for (const m of [
      'anthropic:claude-sonnet-4-6',
      'openai:gpt-5',
      'openrouter:qwen/qwen3-235b-a22b-2507',
      'google:gemini-2.0-flash',
    ]) {
      expect(flooredMaxOutputTokens(m, 16)).toBe(16);
    }
  });

  test('an unknown or unset model is left alone', () => {
    expect(flooredMaxOutputTokens(undefined, 16)).toBe(16);
    expect(flooredMaxOutputTokens('', 16)).toBe(16);
    expect(flooredMaxOutputTokens('mystery-provider:x', 16)).toBe(16);
  });
});
