import type {
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListResult,
  PullRequestListState,
} from "@t3tools/contracts";

export type PullRequestGroupKey = "reviewRequested" | "authored" | "others";

export interface PullRequestGroup {
  readonly key: PullRequestGroupKey;
  readonly label: string;
  readonly entries: ReadonlyArray<PullRequestListEntry>;
}

/** The signed-in account per host, as the listing reports it. */
export type PullRequestViewers = PullRequestListResult["viewers"];

const GROUP_LABELS: Record<PullRequestGroupKey, string> = {
  reviewRequested: "Review requested",
  authored: "Authored",
  others: "Others",
};

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Authorship is per host, not per provider kind: the same list can hold change requests from
 * GitHub, GitLab and a GitHub Enterprise install, and the account that owns one says nothing
 * about the others.
 */
function isAuthoredByViewer(entry: PullRequestListEntry, viewers: PullRequestViewers): boolean {
  const viewer = normalize(viewers[entry.host]);
  return viewer !== null && normalize(entry.author?.login) === viewer;
}

/** Free-text filter over the fields a row actually shows, plus `#123` / `123`. */
export function matchesPullRequestQuery(entry: PullRequestListEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return true;
  return `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(normalizedQuery);
}

/**
 * The server returns the involvement superset for a state, so switching between the Reviewing
 * and Authored tabs never waits on the network.
 */
export function filterPullRequestsByInvolvement(
  entries: ReadonlyArray<PullRequestListEntry>,
  viewers: PullRequestViewers,
  involvement: PullRequestInvolvement,
): ReadonlyArray<PullRequestListEntry> {
  if (involvement === "reviewing") {
    return entries.filter((entry) => entry.viewerReviewRequested);
  }
  if (involvement === "authored") {
    return entries.filter((entry) => isAuthoredByViewer(entry, viewers));
  }
  return entries;
}

/**
 * The rows already read, kept only where the filters now being asked about would keep them.
 */
export function narrowPullRequestsToFilters(
  entries: ReadonlyArray<PullRequestListEntry>,
  filters: {
    readonly state: PullRequestListState;
    readonly projectId: string | undefined;
    readonly host: string | undefined;
  },
): ReadonlyArray<PullRequestListEntry> {
  return entries.filter(
    (entry) =>
      (filters.state === "all" || entry.state === filters.state) &&
      (filters.projectId === undefined || entry.projectId === filters.projectId) &&
      (filters.host === undefined || entry.host === filters.host),
  );
}

/**
 * Only relationships the list data actually carries: no "previously reviewed" bucket is
 * inferred, because the listing has no review history.
 */
export function groupPullRequestsByInvolvement(
  entries: ReadonlyArray<PullRequestListEntry>,
  viewers: PullRequestViewers,
): ReadonlyArray<PullRequestGroup> {
  const buckets: Record<PullRequestGroupKey, PullRequestListEntry[]> = {
    reviewRequested: [],
    authored: [],
    others: [],
  };
  for (const entry of entries) {
    if (isAuthoredByViewer(entry, viewers)) {
      buckets.authored.push(entry);
    } else if (entry.viewerReviewRequested) {
      buckets.reviewRequested.push(entry);
    } else {
      buckets.others.push(entry);
    }
  }
  return (["reviewRequested", "authored", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

/** Repository plus number is unique on one host, so the host makes the key unique overall. */
export function pullRequestEntryKey(entry: PullRequestListEntry): string {
  return `${entry.host}:${entry.repository}#${entry.number}`;
}

/**
 * The priority groups built from the hosts' own answers rather than re-partitioned from the
 * paginated feed.
 */
export function partitionPullRequestsWithPriority(
  entries: ReadonlyArray<PullRequestListEntry>,
  authored: ReadonlyArray<PullRequestListEntry>,
  reviewRequested: ReadonlyArray<PullRequestListEntry>,
): ReadonlyArray<PullRequestGroup> {
  const authoredByKey = new Map(authored.map((entry) => [pullRequestEntryKey(entry), entry]));
  const reviewByKey = new Map(
    reviewRequested.flatMap((entry) => {
      const key = pullRequestEntryKey(entry);
      return authoredByKey.has(key) ? [] : [[key, entry] as const];
    }),
  );
  const others: PullRequestListEntry[] = [];
  for (const entry of entries) {
    const key = pullRequestEntryKey(entry);
    if (authoredByKey.has(key)) {
      authoredByKey.set(key, entry);
    } else if (reviewByKey.has(key)) {
      reviewByKey.set(key, entry);
    } else {
      others.push(entry);
    }
  }
  const byRecency = (left: PullRequestListEntry, right: PullRequestListEntry) =>
    right.updatedAt.localeCompare(left.updatedAt);
  return (
    [
      { key: "reviewRequested", entries: [...reviewByKey.values()].sort(byRecency) },
      { key: "authored", entries: [...authoredByKey.values()].sort(byRecency) },
      { key: "others", entries: others },
    ] as const
  )
    .filter((group) => group.entries.length > 0)
    .map((group) => ({ ...group, label: GROUP_LABELS[group.key] }));
}

export type PullRequestDiffStats = ReadonlyMap<
  string,
  { readonly additions: number; readonly deletions: number }
>;

export function mergePullRequestDiffStats(
  previous: PullRequestDiffStats,
  stats: ReadonlyArray<{
    readonly projectId: string;
    readonly number: number;
    readonly additions: number;
    readonly deletions: number;
  }>,
): PullRequestDiffStats {
  if (stats.length === 0) return previous;
  const next = new Map(previous);
  for (const stat of stats) {
    next.set(`${stat.projectId} ${stat.number}`, {
      additions: stat.additions,
      deletions: stat.deletions,
    });
  }
  return next;
}

export function resolveProjectScope<Id extends string>(
  projectId: Id | undefined,
  projects: ReadonlyArray<{ readonly id: string }>,
  projectsKnown: boolean,
): Id | undefined {
  if (projectId === undefined || !projectsKnown) return projectId;
  return projects.some((project) => project.id === projectId) ? projectId : undefined;
}

export function scorePullRequestMatch(entry: PullRequestListEntry, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const number = needle.replace(/^#/u, "");
  if (/^\d+$/u.test(number)) return String(entry.number) === number ? 100 : 0;

  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter((term) => term.length > 0);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70;
  if (entry.headBranch.toLowerCase().includes(needle)) return 60;
  if ((entry.author?.login ?? "").toLowerCase().includes(needle)) return 50;
  if (entry.repository.toLowerCase().includes(needle)) return 40;
  if (terms.some((term) => title.includes(term))) return 30;
  return 10;
}

export function rankPullRequestMatches(
  entries: ReadonlyArray<PullRequestListEntry>,
  query: string,
): ReadonlyArray<PullRequestListEntry> {
  if (query.trim().length === 0) return entries;
  // Copy then sort: Hermes does not ship Array#toSorted.
  return [...entries].sort((left, right) => {
    const byScore = scorePullRequestMatch(right, query) - scorePullRequestMatch(left, query);
    return byScore !== 0 ? byScore : right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function withDiffStat(
  entry: PullRequestListEntry,
  statsByRow: ReadonlyMap<string, { readonly additions: number; readonly deletions: number }>,
): PullRequestListEntry {
  if (entry.additions !== 0 || entry.deletions !== 0) return entry;
  const stat = statsByRow.get(`${entry.projectId} ${entry.number}`);
  return stat === undefined ? entry : { ...entry, ...stat };
}
