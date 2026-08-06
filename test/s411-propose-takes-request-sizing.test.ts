/**
 * S411 request sizing — a page body larger than the extractor context budget
 * must be truncated to fit, never sent whole (Mnemo escalation 2026-08-06:
 * 17,063-token request vs 16,384 effective context, retried toward
 * dead-letter). Fence rows are capped too — they are dedup context, not the
 * work product.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildExtractorPrompt,
  MAX_PAGE_BODY_CHARS,
  MAX_FENCE_ROWS_FOR_DEDUP,
  EXTRACT_TAKES_PROMPT,
} from '../src/core/cycle/propose-takes.ts';

const scaffoldLen = EXTRACT_TAKES_PROMPT.length;

describe('s411 propose_takes request sizing', () => {
  test('small body passes through untouched', () => {
    const body = 'I bet widget-co raises a series A by Q3.';
    const prompt = buildExtractorPrompt({ pagePath: 'p', pageBody: body, existingTakes: [] });
    expect(prompt).toContain(body);
    expect(prompt).not.toContain('[TRUNCATED by gbrain');
  });

  test('oversized body is truncated to the cap with a marker', () => {
    const body = 'x'.repeat(MAX_PAGE_BODY_CHARS * 3);
    const prompt = buildExtractorPrompt({ pagePath: 'p', pageBody: body, existingTakes: [] });
    expect(prompt).toContain('[TRUNCATED by gbrain');
    // Prompt stays bounded: scaffold + cap + marker + empty fence json + slack.
    expect(prompt.length).toBeLessThan(scaffoldLen + MAX_PAGE_BODY_CHARS + 500);
  });

  test('truncation is deterministic (same body -> same prompt)', () => {
    const body = 'y'.repeat(MAX_PAGE_BODY_CHARS + 999);
    const a = buildExtractorPrompt({ pagePath: 'p', pageBody: body, existingTakes: [] });
    const b = buildExtractorPrompt({ pagePath: 'p', pageBody: body, existingTakes: [] });
    expect(a).toBe(b);
  });

  test('fence rows capped at MAX_FENCE_ROWS_FOR_DEDUP', () => {
    const rows = Array.from({ length: MAX_FENCE_ROWS_FOR_DEDUP * 2 }, (_, i) => ({
      claim: `claim ${i}`,
      kind: 'take',
      holder: 'brain',
      weight: 0.5,
    }));
    const prompt = buildExtractorPrompt({ pagePath: 'p', pageBody: 'short', existingTakes: rows });
    expect(prompt).toContain(`claim ${MAX_FENCE_ROWS_FOR_DEDUP - 1}`);
    expect(prompt).not.toContain(`claim ${MAX_FENCE_ROWS_FOR_DEDUP}"`);
  });
});
