import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  compareRankedSearchResults,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";

const DEFAULT_THREAD_REFERENCE_LIMIT = 20;

function scoreThread(thread: EnvironmentThreadShell, query: string): number | null {
  const fields = [thread.title, thread.branch ?? "", thread.id];
  let best: number | null = null;
  for (const field of fields) {
    const score = scoreQueryMatch({
      value: field.toLowerCase(),
      query,
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 30,
      includesBase: 50,
      fuzzyBase: 100,
    });
    if (score !== null && (best === null || score < best)) {
      best = score;
    }
  }
  return best;
}

export function searchThreadReferences(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  queryInput: string,
  limit = DEFAULT_THREAD_REFERENCE_LIMIT,
): EnvironmentThreadShell[] {
  const query = normalizeSearchQuery(queryInput, { trimLeadingPattern: /^#/ });
  if (!query) {
    return threads
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  const ranked: RankedSearchResult<EnvironmentThreadShell>[] = [];
  for (const thread of threads) {
    const score = scoreThread(thread, query);
    if (score === null) continue;
    ranked.push({ item: thread, score, tieBreaker: `${thread.title}:${thread.id}` });
  }
  return ranked
    .sort(compareRankedSearchResults)
    .slice(0, limit)
    .map(({ item }) => item);
}
