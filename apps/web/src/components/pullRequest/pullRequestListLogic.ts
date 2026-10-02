import type { EnvironmentId, PullRequestListEntry } from "@t3tools/contracts";

export type PullRequestListRowEntry = PullRequestListEntry & {
  readonly environmentId: EnvironmentId;
};

export type PullRequestListItem =
  | { readonly kind: "header"; readonly key: string; readonly title: string }
  | { readonly kind: "row"; readonly key: string; readonly entry: PullRequestListRowEntry };

/** Debounce for server search: immediate input narrows locally, the server follows. */
export const PULL_REQUEST_SEARCH_DEBOUNCE_MS = 350;
/** Pages fetched automatically per environment before an honest "Load more" takes over. */
export const PROGRESSIVE_AUTO_PAGE_BUDGET = 20;
/** Visible rows plus bounded overscan for ordinary diff-stat reads. */
export const VISIBLE_STATS_LIMIT = 120;

/**
 * Complete PR identity: environment plus project, repository (case-insensitive —
 * the same `owner/repo` on two hosts stays distinct via environment/host) and
 * number. Repository casing alone must never fork one PR into two rows.
 */
export function pullRequestEntryKey(entry: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
}): string {
  return `${entry.environmentId}:${entry.projectId}:${entry.repository.toLowerCase()}#${entry.number}`;
}

/** Drop repeated rows across progressive pages while keeping first-seen order. */
export function dedupePullRequestEntries<
  T extends { readonly environmentId: EnvironmentId } & {
    readonly projectId: string;
    readonly repository: string;
    readonly number: number;
  },
>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const entry of entries) {
    const key = pullRequestEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

/** Append a progressive page without losing earlier rows or duplicating cursors. */
export function mergePullRequestPages<
  T extends { readonly environmentId: EnvironmentId } & {
    readonly projectId: string;
    readonly repository: string;
    readonly number: number;
  },
>(existing: readonly T[], incoming: readonly T[]): T[] {
  return dedupePullRequestEntries([...existing, ...incoming]);
}

/**
 * GitHub search expressions (`label:bug`, `author:octocat`, `is:open`) are not
 * ordinary title substrings. When one is present, provisional local narrowing
 * must stand aside and let the authoritative server answer.
 */
export function hasSearchQualifier(query: string): boolean {
  return /\b[a-z][a-z0-9_-]*:/iu.test(query.trim());
}

/**
 * Immediate, provisional narrowing of already loaded rows. Plain text matches
 * title, repository, or number; qualifier searches and empty input return the
 * authoritative rows untouched so server matches (descriptions, comments,
 * labels) are never permanently hidden by a substring filter.
 */
export function narrowEntriesLocally<T extends PullRequestListRowEntry>(
  entries: readonly T[],
  immediateQuery: string,
): readonly T[] {
  const normalized = immediateQuery.trim().toLowerCase();
  if (!normalized || hasSearchQualifier(immediateQuery)) return entries;
  return entries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(normalized) ||
      entry.repository.toLowerCase().includes(normalized) ||
      String(entry.number).includes(normalized),
  );
}

/** True while the immediate input has moved past the debounced server query. */
export function isProvisionalSearch(immediate: string, debounced: string): boolean {
  return immediate.trim() !== debounced.trim();
}

/**
 * Rows diff stats are wanted for under ordinary sorting: the visible render
 * window plus bounded overscan — never every loaded row. Before the
 * virtualizer reports back, the leading rows stand in so the first paint
 * still carries sizes.
 */
export function selectVisibleStatsEntries<T extends PullRequestListRowEntry>(
  ordered: readonly T[],
  renderedKeys: ReadonlySet<string>,
  limit: number,
  fallbackRows: number,
): readonly T[] {
  if (renderedKeys.size === 0) return ordered.slice(0, fallbackRows);
  const visible = ordered.filter((entry) => renderedKeys.has(pullRequestEntryKey(entry)));
  return (visible.length > 0 ? visible : ordered.slice(0, fallbackRows)).slice(0, limit);
}

/** Flatten sections into one virtualized list with stable keys for rows and headers. */
export function buildPullRequestListItems(
  reviewRequested: readonly PullRequestListRowEntry[],
  others: readonly PullRequestListRowEntry[],
): PullRequestListItem[] {
  const items: PullRequestListItem[] = [];
  if (reviewRequested.length > 0) {
    items.push({ kind: "header", key: "header:awaiting", title: "Awaiting your review" });
    for (const entry of reviewRequested) {
      items.push({ kind: "row", key: pullRequestEntryKey(entry), entry });
    }
  }
  if (others.length > 0) {
    items.push({ kind: "header", key: "header:others", title: "Others" });
    for (const entry of others) {
      items.push({ kind: "row", key: pullRequestEntryKey(entry), entry });
    }
  }
  return items;
}
