import { describe, expect, test } from 'bun:test';
import {
  buildPatternsCorpus,
  PATTERNS_CORPUS_CHAR_BUDGET,
} from '../src/core/cycle/patterns.ts';

describe('patterns reflection corpus budget', () => {
  test('keeps newest reflections and reports the omitted tail', () => {
    const reflections = Array.from({ length: 100 }, (_, i) => ({
      slug: `reflections/${i}`,
      title: `Reflection ${i}`,
      excerpt: `evidence-${i} ${'x'.repeat(580)}`,
    }));
    const corpus = buildPatternsCorpus(reflections);
    expect(corpus).toContain('evidence-0');
    expect(corpus).not.toContain('evidence-99');
    expect(corpus).toMatch(/\(\+\d+ older reflection\(s\) omitted for context budget/);
    expect(corpus.length).toBeLessThan(PATTERNS_CORPUS_CHAR_BUDGET + 120);
  });

  test('does not add an omission marker when the corpus fits', () => {
    const corpus = buildPatternsCorpus([
      { slug: 'reflections/one', title: 'One', excerpt: 'small' },
    ]);
    expect(corpus).toContain('[[reflections/one]]');
    expect(corpus).not.toContain('omitted for context budget');
  });
});