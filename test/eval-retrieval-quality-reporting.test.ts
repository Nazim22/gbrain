import { describe, expect, test } from 'bun:test';
import { formatQuestionScoreLine } from '../src/commands/eval-retrieval-quality.ts';
import type { NamedThingQuestion, QuestionResult } from '../src/eval/retrieval-quality/harness.ts';

function result(family: QuestionResult['family'], query: string, rr: number): QuestionResult {
  return {
    family,
    query,
    hit_at_1: rr === 1,
    hit_at_3: rr > 0 && rr >= 1 / 3,
    reciprocal_rank: rr,
    ...(family === 'hard-negative' ? { negative_clean: rr === 1 } : {}),
    recall_at_k: 0,
    recall_at_10: 0,
  };
}

describe('retrieval-quality PQ score reporting', () => {
  test('labels duplicate query text by fixture position, not query key', () => {
    const first: NamedThingQuestion = {
      family: 'generic-to-named', query: 'duplicate', relevant: ['pages/a'],
    };
    const second: NamedThingQuestion = {
      family: 'hard-negative', query: 'duplicate', forbidden: ['pages/bad'],
    };

    expect(formatQuestionScoreLine(0, first, result(first.family, first.query, 1 / 4))).toBe(
      'PQS\t1\tgeneric-to-named\thit1=0\thit3=0\trank=4\trelevant=pages/a\tforbidden=-',
    );
    expect(formatQuestionScoreLine(1, second, result(second.family, second.query, 1))).toBe(
      'PQS\t2\thard-negative\thit1=1\thit3=1\trank=-\trelevant=-\tforbidden=pages/bad',
    );
  });

  test('reports a true miss with rank=-', () => {
    const q: NamedThingQuestion = {
      family: 'title-substring', query: 'named page', relevant: ['pages/named'],
    };
    expect(formatQuestionScoreLine(6, q, result(q.family, q.query, 0))).toContain(
      'PQS\t7\ttitle-substring\thit1=0\thit3=0\trank=-',
    );
  });
});
