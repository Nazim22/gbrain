/**
 * Silent-failure detector for configured-but-non-functional models.
 *
 * The budget audit writes a `reserve` event before a model call and a
 * `record` event after it returns. A model that reserves budget but never
 * records usage is failing 100% of the time — and nothing else surfaces it,
 * because the failure happens below the caller, which just sees an empty
 * result.
 *
 * This is not hypothetical. On the live brain, `anthropic:claude-haiku-4-5`
 * accumulated 3,443 reserves and ZERO records across ~2 months — the
 * configured key simply did not exist. The label on those dead calls was
 * `cycle.extract_atoms`, so atom extraction silently produced nothing while
 * every other check stayed green. Two days were spent chasing it as a model
 * quality problem. The evidence was in this log the whole time.
 *
 * Deliberately ratio-based rather than error-based: it needs no cooperation
 * from the failing path. A provider that dies before it can log an error is
 * exactly the case that most needs catching.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveAuditDir, computeIsoWeekFilename } from './audit-writer.ts';

const FEATURE_NAME = 'budget';

/** Reserve/record tallies for one `provider:model` over the window. */
export interface ModelCompletion {
  model: string;
  reserved: number;
  recorded: number;
  /** Most recent reserve timestamp — lets doctor say when it last tried. */
  last_reserve_ts: string;
}

export interface ReadBudgetCompletionResult {
  models: ModelCompletion[];
  corrupted_lines: number;
  files_scanned: number;
  files_unreadable: number;
}

/**
 * Tally reserve vs record events per model over the last `days`.
 *
 * `*_unpriced` variants count the same as their priced counterparts — an
 * unpriced call still either completed or it didn't, and a model with no
 * pricing entry is exactly the kind that goes unnoticed.
 */
export function readBudgetCompletion(
  days = 7,
  now: Date = new Date(),
): ReadBudgetCompletionResult {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - days * 86_400_000;
  const tally = new Map<string, ModelCompletion>();
  let corruptedLines = 0;
  let filesScanned = 0;
  let filesUnreadable = 0;

  // Walk enough ISO-week files to cover the window plus the Monday-midnight
  // boundary. Mirrors readRecentBatchRetryEvents.
  const weeks = Math.ceil(days / 7) + 1;
  const filenames = Array.from({ length: weeks }, (_, i) =>
    computeIsoWeekFilename(FEATURE_NAME, new Date(now.getTime() - i * 7 * 86_400_000)));

  for (const filename of new Set(filenames)) {
    const file = path.join(dir, filename);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
      filesScanned++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code && code !== 'ENOENT') filesUnreadable++;
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      let ev: { ts?: string; event?: string; model?: string };
      try {
        ev = JSON.parse(line);
      } catch {
        corruptedLines++;
        continue;
      }
      const ts = String(ev.ts ?? '');
      if (!ts || Date.parse(ts) < cutoff) continue;
      const model = String(ev.model ?? '');
      if (!model) continue;

      let row = tally.get(model);
      if (!row) {
        row = { model, reserved: 0, recorded: 0, last_reserve_ts: '' };
        tally.set(model, row);
      }
      const kind = String(ev.event ?? '');
      if (kind === 'reserve' || kind === 'reserve_unpriced') {
        row.reserved++;
        if (ts > row.last_reserve_ts) row.last_reserve_ts = ts;
      } else if (kind === 'record' || kind === 'record_unpriced') {
        row.recorded++;
      }
    }
  }

  return {
    models: [...tally.values()].sort((a, b) => b.reserved - a.reserved),
    corrupted_lines: corruptedLines,
    files_scanned: filesScanned,
    files_unreadable: filesUnreadable,
  };
}

/**
 * Models that reserved budget at least `minAttempts` times and NEVER
 * completed a call. The floor keeps a single in-flight call (reserved, not
 * yet recorded) from reading as a dead provider.
 */
export function findDeadModels(
  result: ReadBudgetCompletionResult,
  minAttempts = 5,
): ModelCompletion[] {
  return result.models.filter((m) => m.recorded === 0 && m.reserved >= minAttempts);
}
