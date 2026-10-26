/**
 * #6720: the content date a page-derived atom inherits from its source page.
 *
 * Read with the extraction input, before the model call, and serialized as
 * the atom's frontmatter `date`, so classic import and managed publication
 * (including a retained-output retry) store the same `effective_date`
 * instead of the extraction run time. The stored projection wins; a legacy
 * page without one is dated by the same precedence chain import uses.
 * A transcript has no source page: it is dated only by a `YYYY-MM-DD` prefix on
 * its file name (transcriptSourceDate), else it gets no date.
 */
import { basename } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { computeEffectiveDate } from '../effective-date.ts';

export async function atomSourceDate(engine: Pick<BrainEngine, 'getConfig'>, page: Page | null): Promise<string | null> {
  if (!page) return null;
  if (page.effective_date) return new Date(page.effective_date).toISOString();
  const { date } = computeEffectiveDate({
    slug: page.slug, frontmatter: page.frontmatter ?? {}, filename: page.slug.split('/').pop(),
    createdAt: new Date(page.created_at), updatedAt: new Date(page.updated_at),
    timeZone: (await engine.getConfig('brain.timezone')) ?? undefined,
  });
  return date ? date.toISOString() : null;
}

/**
 * The content date of a transcript-derived atom: the leading `YYYY-MM-DD` of the
 * transcript's file name, the same prefix transcript discovery reads as the
 * file's date. A name without that prefix, or with an impossible date, gives null.
 */
export function transcriptSourceDate(filePath: string): string | null {
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(basename(filePath))?.[1];
  if (!day) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(day) ? date.toISOString() : null;
}
