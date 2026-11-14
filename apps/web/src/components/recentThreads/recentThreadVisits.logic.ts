export const RECENT_THREAD_LIMIT = 10;

export interface RecentThreadFillCandidate {
  readonly key: string;
  readonly recentUse: number;
}

/** Visits come first and are never cut; fill candidates top the list up to the limit. */
export function recentThreadList(
  visits: readonly string[],
  visibleKeys: ReadonlySet<string>,
  fill: readonly RecentThreadFillCandidate[],
): { readonly keys: readonly string[]; readonly ownCount: number } {
  const keys = visits.filter((key) => visibleKeys.has(key));
  const ownCount = keys.length;
  const seen = new Set(keys);
  for (const candidate of fill.toSorted((a, b) => b.recentUse - a.recentUse)) {
    if (keys.length >= RECENT_THREAD_LIMIT) break;
    if (seen.has(candidate.key) || !visibleKeys.has(candidate.key)) continue;
    seen.add(candidate.key);
    keys.push(candidate.key);
  }
  return { keys, ownCount };
}
