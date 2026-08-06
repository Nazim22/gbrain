import type { BrainEngine } from './engine.ts';
import type {
  LifecycleStatus,
  PageInput,
  PageLifecycle,
  SearchResult,
} from './types.ts';

const HISTORICAL_INTENT = /\b(history|historical|previous|former|superseded|deprecated|retired|timeline|as[- ]of)\b/i;

export function hasHistoricalIntent(query: string): boolean {
  return HISTORICAL_INTENT.test(query);
}

function scalar(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
  return cleaned || null;
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Normalize authoring frontmatter exactly once on the import/write path. */
export function normalizeLifecycle(frontmatter: Record<string, unknown>): Pick<
  PageInput,
  | 'lifecycle_status'
  | 'superseded_by_slug'
  | 'canonical_slug'
  | 'valid_from'
  | 'valid_until'
  | 'authored_at'
> {
  const status = scalar(frontmatter.status)?.toLowerCase();
  const supersededBy = scalar(frontmatter.superseded_by);
  const freshness = scalar(frontmatter.freshness)?.toLowerCase();
  let lifecycleStatus: LifecycleStatus = 'current';
  if (status === 'draft') lifecycleStatus = 'draft';
  else if (status === 'historical') lifecycleStatus = 'historical';
  else if (
    status === 'superseded'
    || status === 'deprecated'
    || status === 'retired'
    || freshness === 'stale'
    || supersededBy !== null
  ) lifecycleStatus = 'superseded';

  return {
    lifecycle_status: lifecycleStatus,
    superseded_by_slug: supersededBy,
    canonical_slug: scalar(frontmatter.canonical_page),
    valid_from: dateOrNull(frontmatter.valid_from),
    valid_until: dateOrNull(frontmatter.valid_until),
    authored_at: dateOrNull(frontmatter.authored_at),
  };
}

function stamp(result: SearchResult, lifecycle: PageLifecycle | undefined): SearchResult {
  if (!lifecycle) {
    return { ...result, lifecycle_status: 'unknown', stale: true };
  }
  return {
    ...result,
    lifecycle_status: lifecycle.lifecycle_status,
    superseded_by: lifecycle.superseded_by ?? undefined,
    superseded_by_page_id: lifecycle.superseded_by_page_id ?? undefined,
    stale: result.stale || lifecycle.lifecycle_status !== 'current',
  };
}

/**
 * Mandatory post-rank policy. Current-state queries return only current pages;
 * a typed successor redirects the result rather than silently losing recall.
 * Historical intent keeps every state but stamps it explicitly.
 */
export async function applyLifecyclePolicy(
  engine: BrainEngine,
  results: SearchResult[],
  query: string,
): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  const getter = engine.getPageLifecycles?.bind(engine);
  if (!getter) return results.map((result) => ({ ...result, lifecycle_status: 'unknown', stale: true }));

  const lifecycles = await getter([...new Set(results.map((result) => result.page_id))]);
  if (hasHistoricalIntent(query)) {
    return results.map((result) => stamp(result, lifecycles.get(result.page_id)));
  }

  const organicByPage = new Map(results.map((result) => [result.page_id, result]));
  const out = new Map<string, SearchResult>();
  for (const result of results) {
    const lifecycle = lifecycles.get(result.page_id);
    if (!lifecycle) continue; // normalized row missing: fail closed for current-state truth.
    if (lifecycle.lifecycle_status === 'current') {
      const current = stamp(result, lifecycle);
      out.set(`${lifecycle.source_id}:${lifecycle.page_id}`, current);
      continue;
    }

    if (!lifecycle.superseded_by_page_id || !lifecycle.superseded_by) continue;
    const organicSuccessor = organicByPage.get(lifecycle.superseded_by_page_id);
    if (organicSuccessor) {
      const successorLifecycle = lifecycles.get(lifecycle.superseded_by_page_id);
      if (successorLifecycle?.lifecycle_status === 'current') {
        const current = stamp(organicSuccessor, successorLifecycle);
        out.set(`${successorLifecycle.source_id}:${successorLifecycle.page_id}`, current);
      }
      continue;
    }

    const successor = await engine.getPage(lifecycle.superseded_by, { sourceId: lifecycle.source_id });
    if (!successor || successor.lifecycle_status !== 'current') continue;
    out.set(`${successor.source_id}:${successor.id}`, {
      ...result,
      slug: successor.slug,
      page_id: successor.id,
      title: successor.title,
      type: successor.type,
      chunk_text: successor.compiled_truth,
      chunk_source: 'compiled_truth',
      chunk_id: -successor.id,
      chunk_index: 0,
      lifecycle_status: 'current',
      superseded_by: undefined,
      superseded_by_page_id: undefined,
      lifecycle_redirected_from: result.slug,
      stale: false,
    });
  }
  return [...out.values()];
}
