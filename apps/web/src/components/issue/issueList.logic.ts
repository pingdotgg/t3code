import * as Schema from "effect/Schema";

import {
  IssueListEntry,
  IssueListResult,
  issueProjectSourceKey,
  issueSourceKey,
} from "@t3tools/contracts";
import type { IssueInvolvement, IssueListSort, IssueListState } from "@t3tools/contracts";

import { normalizeLogin } from "../sourceControl/listHelpers";
import {
  readListSnapshot,
  writeListSnapshot,
  type SnapshotStorage,
} from "../sourceControl/listSnapshot";

export type IssueGroupKey = "assigned" | "authored" | "others";

export interface IssueGroup {
  readonly key: IssueGroupKey;
  readonly label: string;
  readonly entries: ReadonlyArray<IssueListEntry>;
}

export function issueListOrderLabels(
  sort: IssueListSort,
): readonly [ascending: string, descending: string] {
  return sort === "comments" || sort.startsWith("reactions")
    ? ["Ascending", "Descending"]
    : ["Oldest", "Newest"];
}

/** The signed-in account per adapter and host, as the listing reports it. */
export type IssueViewers = IssueListResult["viewers"];

const GROUP_LABELS: Record<IssueGroupKey, string> = {
  assigned: "Assigned to you",
  authored: "Authored",
  others: "Others",
};

function issueViewer(entry: IssueListEntry, viewers: IssueViewers): string | null {
  return normalizeLogin(
    viewers[issueProjectSourceKey(entry.provider, entry.host, entry.projectId)] ??
      viewers[issueSourceKey(entry.provider, entry.host)] ??
      viewers[entry.host],
  );
}

function isAssignedToViewer(entry: IssueListEntry, viewers: IssueViewers): boolean {
  const viewer = issueViewer(entry, viewers);
  return (
    viewer !== null && entry.assignees.some((assignee) => normalizeLogin(assignee.login) === viewer)
  );
}

function isAuthoredByViewer(entry: IssueListEntry, viewers: IssueViewers): boolean {
  const viewer = issueViewer(entry, viewers);
  return viewer !== null && normalizeLogin(entry.author?.login) === viewer;
}

/** Free-text filter over the fields a row actually shows, plus `#123` / `123`. */
export function matchesIssueQuery(entry: IssueListEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return true;
  const assignees = entry.assignees.map((assignee) => assignee.login).join(" ");
  const labels = entry.labels.map((label) => label.name).join(" ");
  return `#${entry.number} ${entry.title} ${entry.repository} ${entry.author?.login ?? ""} ${assignees} ${labels}`
    .toLowerCase()
    .includes(normalizedQuery);
}

export function filterIssueQueryResults(
  entries: ReadonlyArray<IssueListEntry>,
  query: string,
  hostAnswerReady: boolean,
  searchingHosts: ReadonlySet<string>,
): ReadonlyArray<IssueListEntry> {
  if (query.trim().length === 0) return entries;
  return entries.filter(
    (entry) =>
      (hostAnswerReady && searchingHosts.has(entry.host)) || matchesIssueQuery(entry, query),
  );
}

/**
 * The server returns the involvement superset for a state, so switching between the Assigned and
 * Authored tabs never waits on the network.
 *
 * Mentions are the exception: nothing on a row records one, so the hosts' answer is the only
 * answer there is and it stands as it arrived. Narrowing it here against the fields a row does
 * carry would throw away every row the reader asked for.
 */
export function filterIssuesByInvolvement(
  entries: ReadonlyArray<IssueListEntry>,
  viewers: IssueViewers,
  involvement: IssueInvolvement,
): ReadonlyArray<IssueListEntry> {
  if (involvement === "assigned") {
    return entries.filter((entry) => isAssignedToViewer(entry, viewers));
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
 * the new question replaces it. So this may only ever drop rows — a closed issue cannot sit under
 * "Open" for the round trip — and what it leaves is a subset of the answer rather than the answer
 * itself.
 *
 * Only the filters a row can be judged by from its own fields. Involvement is left out because it
 * needs to know who is signed in on each host, and the search text because searching is the
 * hosts' own answer; both are narrowed where that knowledge already lives.
 */
export function narrowIssuesToFilters(
  entries: ReadonlyArray<IssueListEntry>,
  filters: {
    readonly state: IssueListState;
    readonly projectId: string | undefined;
    readonly host: string | undefined;
  },
): ReadonlyArray<IssueListEntry> {
  return entries.filter(
    (entry) =>
      (filters.state === "all" || entry.state === filters.state) &&
      (filters.projectId === undefined || entry.projectId === filters.projectId) &&
      (filters.host === undefined || entry.host === filters.host),
  );
}

/**
 * Only relationships the list data actually carries. A mention is not one of them — a listing row
 * says who filed an issue and who has to do it, never who was named inside it — so an issue the
 * viewer was only mentioned in reads as any other issue here.
 */
export function groupIssuesByInvolvement(
  entries: ReadonlyArray<IssueListEntry>,
  viewers: IssueViewers,
): ReadonlyArray<IssueGroup> {
  const buckets: Record<IssueGroupKey, IssueListEntry[]> = {
    assigned: [],
    authored: [],
    others: [],
  };
  for (const entry of entries) {
    if (isAssignedToViewer(entry, viewers)) {
      buckets.assigned.push(entry);
    } else if (isAuthoredByViewer(entry, viewers)) {
      buckets.authored.push(entry);
    } else {
      buckets.others.push(entry);
    }
  }
  return (["assigned", "authored", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

/** A provider project owns a repository's issue numbers. */
export function issueEntryKey(entry: IssueListEntry): string {
  return JSON.stringify([
    entry.provider,
    entry.host,
    entry.projectId,
    entry.repository,
    entry.number,
  ]);
}

/**
 * The priority groups built from the hosts' own answers rather than re-partitioned from the
 * paginated feed. The feed is sliced by recency, so an older authored or assigned row can be
 * missing from its first page and arrive with a later one; grouping the loaded pages would then
 * move it above rows already read. Here the partitions come whole from their own server-filtered
 * reads, the feed fills "Others" in its own order, and a continuation can only append — a row it
 * carries that a partition already holds is dropped rather than moved.
 *
 * The partitions answer their own question of the hosts, so whatever narrowed the feed afterwards
 * never touched them. `keep` is that narrowing, said again here: without it a label filter takes
 * rows out of "Others" and leaves the very same rows sitting under "Assigned to you".
 */
export function partitionIssuesWithPriority(
  entries: ReadonlyArray<IssueListEntry>,
  authored: ReadonlyArray<IssueListEntry>,
  assigned: ReadonlyArray<IssueListEntry>,
  keep: (entry: IssueListEntry) => boolean,
): ReadonlyArray<IssueGroup> {
  const assignedByKey = new Map(
    assigned.filter(keep).map((entry) => [issueEntryKey(entry), entry]),
  );
  // An issue can be both filed and taken on by the same person; assigned wins, as the local
  // grouping has it, because what is on somebody's plate matters more than who put it there.
  const authoredByKey = new Map(
    authored.flatMap((entry) => {
      const key = issueEntryKey(entry);
      return assignedByKey.has(key) || !keep(entry) ? [] : [[key, entry] as const];
    }),
  );
  const others: IssueListEntry[] = [];
  for (const entry of entries) {
    const key = issueEntryKey(entry);
    // The feed's copy of a partitioned row is at least as fresh — it replaces in place.
    if (assignedByKey.has(key)) {
      assignedByKey.set(key, entry);
    } else if (authoredByKey.has(key)) {
      authoredByKey.set(key, entry);
    } else {
      others.push(entry);
    }
  }
  const byRecency = (left: IssueListEntry, right: IssueListEntry) =>
    right.updatedAt.localeCompare(left.updatedAt);
  return (
    [
      { key: "assigned", entries: [...assignedByKey.values()].toSorted(byRecency) },
      { key: "authored", entries: [...authoredByKey.values()].toSorted(byRecency) },
      { key: "others", entries: others },
    ] as const
  )
    .filter((group) => group.entries.length > 0)
    .map((group) => ({ ...group, label: GROUP_LABELS[group.key] }));
}

/**
 * The priority groups' own server-filtered answers, carried with the feed. An issue assigned to
 * the reader but older than the feed's first page lives only in these, so a snapshot without them
 * cold-starts into an Assigned group missing exactly the rows that made it worth having.
 */
export type IssuePartitionsSnapshot = {
  readonly authored: ReadonlyArray<IssueListEntry>;
  readonly assigned: ReadonlyArray<IssueListEntry>;
};

export interface IssueListSnapshot {
  readonly scope: string;
  readonly data: IssueListResult;
  readonly partitions?: IssuePartitionsSnapshot | undefined;
}

const SNAPSHOT_KEY_PREFIX = "t3.issues.list";

const SnapshotSchema = Schema.Struct({
  scope: Schema.String,
  data: IssueListResult,
  // Optional so a snapshot written before the partitions existed still hydrates the feed.
  partitions: Schema.optional(
    Schema.Struct({
      authored: Schema.Array(IssueListEntry),
      assigned: Schema.Array(IssueListEntry),
    }),
  ),
});

export function readIssueListSnapshot(
  storage: SnapshotStorage | undefined,
  environmentId: string,
): IssueListSnapshot | null {
  return readListSnapshot(storage, SnapshotSchema, SNAPSHOT_KEY_PREFIX, environmentId);
}

export function writeIssueListSnapshot(
  storage: SnapshotStorage | undefined,
  environmentId: string,
  snapshot: IssueListSnapshot,
): void {
  writeListSnapshot(storage, SNAPSHOT_KEY_PREFIX, environmentId, snapshot);
}

export { resolveProjectScope } from "../sourceControl/projectScope";

/**
 * How well a row answers the text that was searched for, as a number to order by.
 *
 * Every host searches more than a row shows — GitHub and GitLab read bodies and comments — so a
 * result can be a real match with nothing on the row to show for it. Ordering those by recency
 * alone is what puts an apparently unrelated issue between two obvious ones. They are still
 * results, so they are still shown; they are shown last, under the rows whose own words matched.
 *
 * The scale is deliberately coarse. It sorts rows into "this is the one", "this mentions it" and
 * "the host says so", which is as fine a judgement as the row's own fields support.
 */
export function scoreIssueMatch(entry: IssueListEntry, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const number = needle.replace(/^#/u, "");
  // Asking for a number is asking for one issue, and it is the answer or it is not.
  if (/^\d+$/u.test(number)) return String(entry.number) === number ? 100 : 0;

  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter((term) => term.length > 0);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  // Every word, in any order: "crash startup" is still about the startup crash.
  if (terms.length > 1 && terms.every((term) => title.includes(term))) return 70;
  if ((entry.author?.login ?? "").toLowerCase().includes(needle)) return 60;
  if (entry.assignees.some((assignee) => assignee.login.toLowerCase().includes(needle))) return 50;
  if (entry.labels.some((label) => label.name.toLowerCase().includes(needle))) return 40;
  if (entry.repository.toLowerCase().includes(needle)) return 30;
  if (terms.some((term) => title.includes(term))) return 20;
  // The host matched something this row does not show — a body, a comment.
  return 10;
}

/**
 * Search results in the order they answer the question, most convincing first, and by recency
 * among equals. Only for a search: without one, a listing is a timeline and recency is the order.
 */
export function rankIssueMatches(
  entries: ReadonlyArray<IssueListEntry>,
  query: string,
): ReadonlyArray<IssueListEntry> {
  if (query.trim().length === 0) return entries;
  return entries.toSorted((left, right) => {
    const byScore = scoreIssueMatch(right, query) - scoreIssueMatch(left, query);
    return byScore !== 0 ? byScore : right.updatedAt.localeCompare(left.updatedAt);
  });
}
