import * as Schema from "effect/Schema";

import { PullRequestListEntry, PullRequestListResult } from "@t3tools/contracts";
import type { PullRequestInvolvement, PullRequestListState } from "@t3tools/contracts";

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
 *
 * Every combination of filters is its own question to the hosts, and asking a new one is no
 * reason to blank the page: what has been read is narrowed here and stays until the answer for
 * the new question replaces it. So this may only ever drop rows — a merged pull request cannot
 * sit under "Open" for the round trip — and what it leaves is a subset of the answer rather than
 * the answer itself.
 *
 * Only the filters a row can be judged by from its own fields. Involvement is left out because
 * it needs to know who is signed in on each host, and the search text because searching is the
 * hosts' own answer; both are narrowed where that knowledge already lives.
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
 * paginated feed. The feed is sliced by recency, so an older authored or review-requested row
 * can be missing from its first page and arrive with a later one; grouping the loaded pages
 * would then move it above rows already read. Here the partitions come whole from their own
 * server-filtered reads, the feed fills "Others" in its own order, and a continuation can only
 * append — a row it carries that a partition already holds is dropped rather than moved.
 */
export function partitionPullRequestsWithPriority(
  entries: ReadonlyArray<PullRequestListEntry>,
  authored: ReadonlyArray<PullRequestListEntry>,
  reviewRequested: ReadonlyArray<PullRequestListEntry>,
): ReadonlyArray<PullRequestGroup> {
  const authoredByKey = new Map(authored.map((entry) => [pullRequestEntryKey(entry), entry]));
  // A row can be both authored and review-requested; authored wins, as the local grouping has it.
  const reviewByKey = new Map(
    reviewRequested.flatMap((entry) => {
      const key = pullRequestEntryKey(entry);
      return authoredByKey.has(key) ? [] : [[key, entry] as const];
    }),
  );
  const others: PullRequestListEntry[] = [];
  for (const entry of entries) {
    const key = pullRequestEntryKey(entry);
    // The feed's copy of a partitioned row is at least as fresh — it replaces in place.
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
      { key: "reviewRequested", entries: [...reviewByKey.values()].toSorted(byRecency) },
      { key: "authored", entries: [...authoredByKey.values()].toSorted(byRecency) },
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

/**
 * The line counts held so far, with a new batch merged on. The stats read is keyed by the rows
 * on screen, so adding or removing one row is a fresh query with nothing in it yet; replacing
 * the map would blank every count already showing for the round trip. Merging by row identity
 * keeps them until their replacements arrive.
 */
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

/** One page is what the list itself starts with, and all a cold start needs to look warm. */
const SNAPSHOT_MAX_ENTRIES = 99;

type SnapshotStorage = Pick<Storage, "getItem" | "setItem">;

const snapshotStorageKey = (environmentId: string) => `t3.pullRequests.list:${environmentId}`;

/**
 * The priority groups' own server-filtered answers, carried with the feed. An authored pull
 * request older than the feed's first page lives only in these, so a snapshot without them
 * cold-starts into an Authored group missing exactly the rows that made it worth having.
 */
export interface PullRequestPartitionsSnapshot {
  readonly authored: ReadonlyArray<PullRequestListEntry>;
  readonly reviewing: ReadonlyArray<PullRequestListEntry>;
}

export interface PullRequestListSnapshot {
  readonly scope: string;
  readonly data: PullRequestListResult;
  readonly partitions?: PullRequestPartitionsSnapshot | undefined;
}

/**
 * Decoded with the contract's own schema rather than trusted from a cast: storage is writable
 * by anything in the origin and by any past version of this app, and one malformed row would
 * otherwise crash the list on every reload until the key is cleared. A snapshot from before a
 * schema change is rejected the same way, which is exactly the cold start it would have broken.
 */
const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.Struct({
    scope: Schema.String,
    data: PullRequestListResult,
    // Optional so a snapshot written before the partitions existed still hydrates the feed.
    partitions: Schema.optional(
      Schema.Struct({
        authored: Schema.Array(PullRequestListEntry),
        reviewing: Schema.Array(PullRequestListEntry),
      }),
    ),
  }),
);

/**
 * The last list answered for this environment, brought back across a reload. The registry the
 * queries live in is recreated with the renderer, so without this a revisit cold-starts into
 * skeletons even though almost every row is unchanged; hydrated, the stale rows render at once
 * and the live read reconciles them in place by key. Errors are not carried — a failure is
 * never cached, and yesterday's is not this morning's.
 */
export function readPullRequestListSnapshot(
  storage: SnapshotStorage | undefined,
  environmentId: string,
): PullRequestListSnapshot | null {
  try {
    const raw = storage?.getItem(snapshotStorageKey(environmentId));
    if (!raw) return null;
    const decoded = decodeSnapshot(JSON.parse(raw));
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}

export function writePullRequestListSnapshot(
  storage: SnapshotStorage | undefined,
  environmentId: string,
  snapshot: PullRequestListSnapshot,
): void {
  try {
    storage?.setItem(
      snapshotStorageKey(environmentId),
      JSON.stringify({
        scope: snapshot.scope,
        data: {
          ...snapshot.data,
          entries: snapshot.data.entries.slice(0, SNAPSHOT_MAX_ENTRIES),
          // A failure is never cached and yesterday's is not this morning's; a cursor names a
          // position in a listing the host has long since forgotten.
          errors: [],
          nextCursors: {},
        },
        ...(snapshot.partitions === undefined
          ? {}
          : {
              partitions: {
                authored: snapshot.partitions.authored.slice(0, SNAPSHOT_MAX_ENTRIES),
                reviewing: snapshot.partitions.reviewing.slice(0, SNAPSHOT_MAX_ENTRIES),
              },
            }),
      }),
    );
  } catch {
    // Storage can be full or denied; the snapshot is a convenience, not a record.
  }
}

/**
 * The project scope to actually ask for. A `projectId` in the URL outlives the environment it
 * came from, and one from elsewhere narrows the listing to nothing — an empty page with no
 * visible filter explaining it, since the switcher has no such project to show as selected. So
 * an id the environment does not have is dropped.
 *
 * Until `projectsKnown`, the id is kept rather than dropped: an environment that has not
 * reported yet is not the same as one without the project, and dropping first would show every
 * project's pull requests for a moment before narrowing back down.
 */
export function resolveProjectScope<Id extends string>(
  projectId: Id | undefined,
  projects: ReadonlyArray<{ readonly id: string }>,
  projectsKnown: boolean,
): Id | undefined {
  if (projectId === undefined || !projectsKnown) return projectId;
  return projects.some((project) => project.id === projectId) ? projectId : undefined;
}

/**
 * How well a row answers the text that was searched for, as a number to order by.
 *
 * Every host searches more than a row shows — GitHub reads bodies and commit messages, GitLab
 * and Bitbucket read descriptions — so a result can be a real match with nothing on the row to
 * show for it. Ordering those by recency alone is what puts an apparently unrelated pull request
 * between two obvious ones. They are still results, so they are still shown; they are shown last,
 * under the rows whose own words matched.
 *
 * The scale is deliberately coarse. It sorts rows into "this is the one", "this mentions it" and
 * "the host says so", which is as fine a judgement as the row's own fields support.
 */
export function scorePullRequestMatch(entry: PullRequestListEntry, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const number = needle.replace(/^#/u, "");
  // Asking for a number is asking for one pull request, and it is the answer or it is not.
  if (/^\d+$/u.test(number)) return String(entry.number) === number ? 100 : 0;

  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter((term) => term.length > 0);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  // Every word, in any order: "wizard welcome" is still about the welcome wizard.
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70;
  if (entry.headBranch.toLowerCase().includes(needle)) return 60;
  if ((entry.author?.login ?? "").toLowerCase().includes(needle)) return 50;
  if (entry.repository.toLowerCase().includes(needle)) return 40;
  if (terms.some((term) => title.includes(term))) return 30;
  // The host matched something this row does not show — a description, a comment, a commit.
  return 10;
}

/**
 * Search results in the order they answer the question, most convincing first, and by recency
 * among equals. Only for a search: without one, a listing is a timeline and recency is the order.
 */
export function rankPullRequestMatches(
  entries: ReadonlyArray<PullRequestListEntry>,
  query: string,
): ReadonlyArray<PullRequestListEntry> {
  if (query.trim().length === 0) return entries;
  return entries.toSorted((left, right) => {
    const byScore = scorePullRequestMatch(right, query) - scorePullRequestMatch(left, query);
    return byScore !== 0 ? byScore : right.updatedAt.localeCompare(left.updatedAt);
  });
}

/**
 * A row with the line counts that arrived after it did. Only where the host left them out — a
 * listing that carried them is not second-guessed — and only where they have arrived, since a row
 * draws perfectly well without them in the meantime.
 */
export function withDiffStat(
  entry: PullRequestListEntry,
  statsByRow: ReadonlyMap<string, { readonly additions: number; readonly deletions: number }>,
): PullRequestListEntry {
  if (entry.additions !== 0 || entry.deletions !== 0) return entry;
  const stat = statsByRow.get(`${entry.projectId} ${entry.number}`);
  return stat === undefined ? entry : { ...entry, ...stat };
}
