// S553 Luna canary: both blind raters failed atoms that wrote an announced or
// requested change as done, and one whose lesson dropped the body's condition.
// Prompt-presence regression only; the fresh blind canary is the behavioural proof.
import { describe, test, expect } from 'bun:test';
import { atomsPrompt } from '../../src/core/cycle/extract-atoms.ts';

const { system } = atomsPrompt(false, 'session-x.txt', 'y');

describe('EXTRACT_PROMPT: an announced change is not a done change', () => {
  test('an outcome needs evidence of that outcome; a commit is not a deployment', () => {
    expect(system).toContain('An announced, requested or planned change is not a done change.');
    expect(system).toContain('a commit proves committed code, not a deployment or its effect.');
    expect(system).toContain('Otherwise say proposed, requested or planned, in the title, body AND lesson.');
  });
  test('conditions survive into the lesson', () => {
    expect(system).toContain('a lesson must not drop one.');
  });
});
