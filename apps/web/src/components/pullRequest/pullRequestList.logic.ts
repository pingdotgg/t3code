import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  PullRequestListEntry,
  PullRequestListProjectError,
  PullRequestListResult,
  resolvePullRequestAuthorFilter,
} from "@t3tools/contracts";
import type {
  PullRequestDiffStat,
  PullRequestInvolvement,
  PullRequestListCursors,
  PullRequestListFilters,
  PullRequestListState,
} from "@t3tools/contracts";

/**
 * A listed change request with the environment that read it. Nothing on a row says which machine
 * it came from, and the page unions every connected one — so acting on a row, refreshing it, or
 * opening its detail all need the tag the listing itself does not carry.
 */
export interface EnvironmentPullRequestEntry extends PullRequestListEntry {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentPullRequestStat extends PullRequestDiffStat {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentPullRequestError extends PullRequestListProjectError {
  readonly environmentId: EnvironmentId;
}

export type PullRequestGroupKey = "reviewRequested" | "authored" | "others";

export interface PullRequestGroup<Entry extends PullRequestListEntry = PullRequestListEntry> {
  readonly key: PullRequestGroupKey;
  readonly label: string;
  readonly entries: ReadonlyArray<Entry>;
}

/**
 * The signed-in account per host. Keyed `"<environmentId> <host>"` once a listing spans more than
 * one environment: two machines can both reach github.com signed in as different people, and a
 * single host-keyed record would let whichever answered last decide who "I" am — which is how
 * every row of somebody's own work came to be filed under Others.
 */
export type PullRequestViewers = PullRequestListResult["viewers"];

/** A row plus the environment that read it, where the caller has one to give. */
type ScopedEntry = PullRequestListEntry & { readonly environmentId?: string };

export const pullRequestViewerKey = (entry: ScopedEntry): string =>
  `${entry.environmentId ?? ""} ${entry.host}`;

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
 * The signed-in login for the host a row came from, or null where none was given. Shared by
 * authorship matching here and by `author:me` resolution wherever a row's own viewer is needed.
 */
export function pullRequestEntryViewer(
  entry: ScopedEntry,
  viewers: PullRequestViewers,
): string | null {
  // The environment's own answer first; a plain host key is what a single-environment listing
  // still writes, and what the snapshot from one carries.
  return normalize(viewers[pullRequestViewerKey(entry)] ?? viewers[entry.host]);
}

/**
 * Authorship is per host, not per provider kind: the same list can hold change requests from
 * GitHub, GitLab and a GitHub Enterprise install, and the account that owns one says nothing
 * about the others.
 */
function isAuthoredByViewer(entry: ScopedEntry, viewers: PullRequestViewers): boolean {
  const viewer = pullRequestEntryViewer(entry, viewers);
  return viewer !== null && normalize(entry.author?.login) === viewer;
}

/** What `review:` and `status:` take, in GitHub's spelling and in the contract's. */
const REVIEW_VALUES: Record<string, PullRequestListFilters["review"]> = {
  approved: "approved",
  changes_requested: "changes-requested",
  "changes-requested": "changes-requested",
  required: "review-required",
  "review-required": "review-required",
  none: "none",
};
const CHECKS_VALUES: Record<string, PullRequestListFilters["checks"]> = {
  success: "passing",
  passing: "passing",
  failure: "failing",
  failing: "failing",
};

/**
 * One token of a typed query: a run of non-space characters in which a quoted stretch counts as
 * part of the token, so `label:"needs design"` stays whole. An unbalanced quote is dropped rather
 * than swallowing the rest of the line.
 */
const QUERY_TOKEN = /(?:[^\s"]|"[^"]*")+/g;
/** The contract's own ceilings on a qualifier: this many names, each this long. */
const MAX_QUALIFIER_VALUES = 10;
const MAX_QUALIFIER_LENGTH = 200;

function qualifierValue(raw: string): string {
  return raw.replaceAll('"', "").trim();
}

/** A qualifier's value as the list it may be: split on commas, each name unquoted on its own. */
function splitQualifierList(raw: string): string[] {
  // Quoting names one whole label however many commas it holds: `label:"needs,triage"` asks for
  // the label written that way, not for either half of it.
  if (/^\s*"[^"]*"\s*$/.test(raw)) {
    const whole = qualifierValue(raw);
    return whole.length === 0 ? [] : [whole];
  }
  return raw
    .split(",")
    .map((part) => qualifierValue(part))
    .filter((part) => part.length > 0);
}

/**
 * A typed query is written by hand, and the contract bounds what a qualifier may carry — so what
 * is typed past those bounds is cut here rather than refused by the request that carries it.
 */
function boundedNames(names: ReadonlyArray<string>): string[] {
  return names
    .slice(0, MAX_QUALIFIER_VALUES)
    .map((name) => name.slice(0, MAX_QUALIFIER_LENGTH).trim())
    .filter((name) => name.length > 0);
}

/**
 * A typed query split into the qualifiers the hosts can act on and the text that is left. Written
 * GitHub's way — `label:foo`, `-label:"needs design"`, `author:octocat`, `draft:true`,
 * `review:approved`, `status:success` — because a project's labels are its own and a menu cannot
 * list them.
 *
 * A key this does not know is read as a label of that whole name: repositories namespace their
 * labels with a colon — `size:XXL`, `area:web`, `vouch:trusted` — and someone typing one means
 * the label, not a description that happens to contain it. `-size:XXL` excludes the same way.
 *
 * Quoting is the way back to plain text: `"size:XXL"` is searched for as written, which is what
 * makes a literal search for a colon still possible. A known key whose value it does not take is
 * text too, so a search for "status:" itself is still findable.
 */
export function parsePullRequestQuery(raw: string): {
  readonly text: string;
  readonly filters: PullRequestListFilters;
} {
  const text: string[] = [];
  const labels: string[][] = [];
  const excludedLabels: string[] = [];
  let author: string | undefined;
  let draft: PullRequestListFilters["draft"];
  let review: PullRequestListFilters["review"];
  let checks: PullRequestListFilters["checks"];
  for (const [token] of raw.matchAll(QUERY_TOKEN)) {
    const qualifier = /^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(token);
    const value = qualifier === null ? "" : qualifierValue(qualifier[3] ?? "");
    const negated = qualifier?.[1] === "-";
    switch (value.length === 0 ? "" : (qualifier?.[2]?.toLowerCase() ?? "")) {
      case "label": {
        // GitHub's own OR: `label:a,b` is one qualifier satisfied by either name. Negated, the
        // comma excludes each — a row carrying any of them goes.
        const names = boundedNames(splitQualifierList(qualifier?.[3] ?? ""));
        if (names.length === 0) break;
        if (negated) excludedLabels.push(...names);
        else labels.push(names);
        continue;
      }
      case "author":
        if (negated) break;
        author = value.slice(0, MAX_QUALIFIER_LENGTH).trim();
        continue;
      case "draft":
        if (negated || (value.toLowerCase() !== "true" && value.toLowerCase() !== "false")) break;
        draft = value.toLowerCase() === "true" ? "only" : "hide";
        continue;
      case "review": {
        const decision = negated ? undefined : REVIEW_VALUES[value.toLowerCase()];
        if (decision === undefined) break;
        review = decision;
        continue;
      }
      case "status":
      case "checks": {
        const state = negated ? undefined : CHECKS_VALUES[value.toLowerCase()];
        if (state === undefined) break;
        checks = state;
        continue;
      }
      case "":
        break;
      default:
        // An unknown key, read as the namespaced label it almost always is. A pasted link is
        // not one — `https://…` would otherwise become a label named after its own scheme.
        if (!value.startsWith("/")) {
          // The key names the namespace, so the bare parts of `size:S,XS` are both sizes. A part
          // that already carries a colon names its whole label — `size:S,size:XS` is the same
          // pair written out, and prefixing it again would ask for `size:size:XS`.
          const names = boundedNames(
            splitQualifierList(qualifier?.[3] ?? "").map((name) =>
              name.includes(":") ? name : `${qualifier?.[2] ?? ""}:${name}`,
            ),
          );
          if (names.length === 0) break;
          if (negated) excludedLabels.push(...names);
          else labels.push(names);
          continue;
        }
    }
    text.push(token);
  }
  return {
    text: text.join(" "),
    filters: {
      ...(labels.length === 0 ? {} : { labels: labels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(excludedLabels.length === 0
        ? {}
        : { excludedLabels: excludedLabels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(author === undefined ? {} : { author }),
      ...(draft === undefined ? {} : { draft }),
      ...(review === undefined ? {} : { review }),
      ...(checks === undefined ? {} : { checks }),
    },
  };
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
export function filterPullRequestsByInvolvement<Entry extends ScopedEntry>(
  entries: ReadonlyArray<Entry>,
  viewers: PullRequestViewers,
  involvement: PullRequestInvolvement,
): ReadonlyArray<Entry> {
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
export function narrowPullRequestsToFilters<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  filters: {
    readonly state: PullRequestListState;
    readonly projectId: string | undefined;
    readonly host: string | undefined;
  },
): ReadonlyArray<Entry> {
  return entries.filter(
    (entry) =>
      (filters.state === "all" || entry.state === filters.state) &&
      (filters.projectId === undefined || entry.projectId === filters.projectId) &&
      (filters.host === undefined || entry.host === filters.host),
  );
}

/**
 * The further narrowings over rows that have already arrived, for the hosts that could not apply
 * them themselves and for the moment before an answer that did lands.
 *
 * `checks` is absent because no listed row carries its check state: that one filter is the
 * host's alone, and a row a host did not narrow stays rather than being guessed at.
 *
 * `viewer` is the row's own host's signed-in login, so `author:me` resolves against it rather
 * than being compared as the literal name "me". Optional, and left unresolved without one.
 */
export function matchesPullRequestFilters(
  entry: PullRequestListEntry,
  filters: PullRequestListFilters,
  viewer?: string | null,
): boolean {
  const labels = new Set(entry.labels.map((label) => label.name.trim().toLowerCase()));
  const holds = (label: string) => labels.has(label.trim().toLowerCase());
  return (
    (filters.draft === undefined || entry.isDraft === (filters.draft === "only")) &&
    (filters.review === undefined ||
      (filters.review === "none"
        ? entry.reviewDecision === undefined
        : entry.reviewDecision === filters.review)) &&
    (filters.labels === undefined || filters.labels.every((group) => group.some(holds))) &&
    (filters.excludedLabels === undefined || !filters.excludedLabels.some(holds)) &&
    (filters.author === undefined ||
      entry.author?.login.toLowerCase() ===
        resolvePullRequestAuthorFilter(filters.author, viewer).toLowerCase())
  );
}

/**
 * Only relationships the list data actually carries: no "previously reviewed" bucket is
 * inferred, because the listing has no review history.
 */
export function groupPullRequestsByInvolvement<Entry extends ScopedEntry>(
  entries: ReadonlyArray<Entry>,
  viewers: PullRequestViewers,
): ReadonlyArray<PullRequestGroup<Entry>> {
  const buckets: Record<PullRequestGroupKey, Entry[]> = {
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

/**
 * Repository plus number is unique on one host, so the host makes the key unique overall — and
 * the environment on top of that, because two connected machines can hold the same repository and
 * would otherwise contribute two rows under one key.
 */
export function pullRequestEntryKey(entry: ScopedEntry): string {
  const scope = entry.environmentId === undefined ? "" : `${entry.environmentId}:`;
  return `${scope}${entry.host}:${entry.repository}#${entry.number}`;
}

/**
 * The priority groups built from the hosts' own answers rather than re-partitioned from the
 * paginated feed. The feed is sliced by recency, so an older authored or review-requested row
 * can be missing from its first page and arrive with a later one; grouping the loaded pages
 * would then move it above rows already read. Here the partitions come whole from their own
 * server-filtered reads, the feed fills "Others" in its own order, and a continuation can only
 * append — a row it carries that a partition already holds is dropped rather than moved.
 */
export function partitionPullRequestsWithPriority<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  authored: ReadonlyArray<Entry>,
  reviewRequested: ReadonlyArray<Entry>,
): ReadonlyArray<PullRequestGroup<Entry>> {
  const authoredByKey = new Map(authored.map((entry) => [pullRequestEntryKey(entry), entry]));
  // A row can be both authored and review-requested; authored wins, as the local grouping has it.
  const reviewByKey = new Map(
    reviewRequested.flatMap((entry) => {
      const key = pullRequestEntryKey(entry);
      return authoredByKey.has(key) ? [] : [[key, entry] as const];
    }),
  );
  const others: Entry[] = [];
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
  const byRecency = (left: Entry, right: Entry) => right.updatedAt.localeCompare(left.updatedAt);
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
    readonly environmentId: string;
    readonly projectId: string;
    readonly number: number;
    readonly additions: number;
    readonly deletions: number;
  }>,
): PullRequestDiffStats {
  if (stats.length === 0) return previous;
  const next = new Map(previous);
  for (const stat of stats) {
    next.set(diffStatKey(stat), { additions: stat.additions, deletions: stat.deletions });
  }
  return next;
}

/** A project id only names a project within its own environment, so the key carries both. */
const diffStatKey = (row: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly number: number;
}) => `${row.environmentId} ${row.projectId} ${row.number}`;

/**
 * Every connected environment's listing, read as one list.
 *
 * `nextCursors` is keyed by environment rather than by repository: a cursor only means anything
 * to the host that issued it, and two machines can hold the same repository. `viewers` is not —
 * a host names one account, and the same host reached from two machines is the same account.
 */
export interface MergedPullRequestList {
  /** Keyed `"<environmentId> <host>"`, so one host's two accounts stay two accounts. */
  readonly viewers: PullRequestViewers;
  readonly providers: PullRequestListResult["providers"];
  readonly entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  readonly errors: ReadonlyArray<EnvironmentPullRequestError>;
  readonly truncated: boolean;
  readonly nextCursors: Readonly<Record<string, PullRequestListCursors>>;
  /**
   * The environments with rows still on their hosts. Those with a cursor are continued from it;
   * the rest can only be reached by asking them for a longer page, and are named here so that
   * asking still happens once every other environment has run out of cursors.
   */
  readonly truncatedEnvironments: ReadonlyArray<string>;
}

/**
 * The environments' answers folded into one. A host reached from more than one environment is one
 * row in the switcher, readable if any environment could read it and searched on the host only if
 * every one of them did — a host answering unnarrowed anywhere still needs the local pass.
 */
export function mergePullRequestLists(
  answers: ReadonlyArray<readonly [EnvironmentId, PullRequestListResult]>,
): MergedPullRequestList | null {
  if (answers.length === 0) return null;
  const viewers: Record<string, string> = {};
  const truncatedEnvironments: string[] = [];
  const providers = new Map<string, PullRequestListResult["providers"][number]>();
  const entries: EnvironmentPullRequestEntry[] = [];
  const errors: EnvironmentPullRequestError[] = [];
  const nextCursors: Record<string, PullRequestListCursors> = {};
  let truncated = false;
  for (const [environmentId, answer] of answers) {
    for (const [host, login] of Object.entries(answer.viewers)) {
      viewers[`${environmentId} ${host}`] = login;
    }
    for (const provider of answer.providers) {
      const held = providers.get(provider.host);
      providers.set(
        provider.host,
        held === undefined
          ? provider
          : {
              ...(held.configured ? held : provider),
              projectCount: held.projectCount + provider.projectCount,
              searchesOnHost: held.searchesOnHost && provider.searchesOnHost,
              configured: held.configured || provider.configured,
            },
      );
    }
    entries.push(...answer.entries.map((entry) => ({ ...entry, environmentId })));
    errors.push(...answer.errors.map((error) => ({ ...error, environmentId })));
    truncated ||= answer.truncated;
    if (answer.truncated) truncatedEnvironments.push(environmentId);
    if (Object.keys(answer.nextCursors).length > 0) {
      nextCursors[environmentId] = answer.nextCursors;
    }
  }
  return {
    viewers,
    providers: [...providers.values()],
    entries: entries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    errors,
    truncated,
    nextCursors,
    truncatedEnvironments,
  };
}

/** One page is what the list itself starts with, and all a cold start needs to look warm. */
const SNAPSHOT_MAX_ENTRIES = 99;

type SnapshotStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Keyed by the whole set of environments the list was read from: connecting or dropping one
 * changes which rows belong on the page, and a snapshot taken from a different set would
 * hydrate rows no longer being read.
 */
export const pullRequestEnvironmentSetKey = (environmentIds: ReadonlyArray<string>): string =>
  [...environmentIds].sort((left, right) => left.localeCompare(right)).join(",");

const snapshotStorageKey = (environmentSetKey: string) =>
  `t3.pullRequests.list:${environmentSetKey}`;

/**
 * The priority groups' own server-filtered answers, carried with the feed. An authored pull
 * request older than the feed's first page lives only in these, so a snapshot without them
 * cold-starts into an Authored group missing exactly the rows that made it worth having.
 */
export interface PullRequestPartitionsSnapshot {
  readonly authored: ReadonlyArray<EnvironmentPullRequestEntry>;
  readonly reviewing: ReadonlyArray<EnvironmentPullRequestEntry>;
}

export interface PullRequestListSnapshot {
  readonly scope: string;
  readonly data: MergedPullRequestList;
  readonly partitions?: PullRequestPartitionsSnapshot | undefined;
}

/**
 * Decoded with the contract's own schema rather than trusted from a cast: storage is writable
 * by anything in the origin and by any past version of this app, and one malformed row would
 * otherwise crash the list on every reload until the key is cleared. A snapshot from before a
 * schema change is rejected the same way, which is exactly the cold start it would have broken.
 */
const EnvironmentPullRequestEntrySchema = Schema.Struct({
  ...PullRequestListEntry.fields,
  environmentId: EnvironmentId,
});

const EnvironmentPullRequestErrorSchema = Schema.Struct({
  ...PullRequestListProjectError.fields,
  environmentId: EnvironmentId,
});

const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.Struct({
    scope: Schema.String,
    data: Schema.Struct({
      ...PullRequestListResult.fields,
      entries: Schema.Array(EnvironmentPullRequestEntrySchema),
      errors: Schema.Array(EnvironmentPullRequestErrorSchema),
      // Per environment here, unlike the wire shape, which is per repository within one.
      nextCursors: Schema.Record(Schema.String, PullRequestListResult.fields.nextCursors),
      truncatedEnvironments: Schema.Array(Schema.String),
    }),
    // Optional so a snapshot written before the partitions existed still hydrates the feed.
    partitions: Schema.optional(
      Schema.Struct({
        authored: Schema.Array(EnvironmentPullRequestEntrySchema),
        reviewing: Schema.Array(EnvironmentPullRequestEntrySchema),
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
  environmentSetKey: string,
): PullRequestListSnapshot | null {
  try {
    const raw = storage?.getItem(snapshotStorageKey(environmentSetKey));
    if (!raw) return null;
    const decoded = decodeSnapshot(JSON.parse(raw));
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}

export function writePullRequestListSnapshot(
  storage: SnapshotStorage | undefined,
  environmentSetKey: string,
  snapshot: PullRequestListSnapshot,
): void {
  try {
    storage?.setItem(
      snapshotStorageKey(environmentSetKey),
      JSON.stringify({
        scope: snapshot.scope,
        data: {
          ...snapshot.data,
          entries: snapshot.data.entries.slice(0, SNAPSHOT_MAX_ENTRIES),
          // A failure is never cached and yesterday's is not this morning's; a cursor names a
          // position in a listing the host has long since forgotten.
          errors: [],
          nextCursors: {},
          // Where a listing stopped is as stale as the cursor that named it.
          truncatedEnvironments: [],
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
 * The project an id names, on the server that owns it. A project id is only unique within its own
 * environment, so an id alone can name two projects on two connected machines: with a server in
 * hand the answer is exact, and without one it is only given where a single environment has that
 * id — narrowing to the wrong machine reads an empty list nobody asked for.
 */
export function findScopedProject<
  Project extends { readonly id: string; readonly environmentId: string },
>(
  projects: ReadonlyArray<Project>,
  environmentId: string | null | undefined,
  projectId: string | undefined,
): Project | undefined {
  if (projectId === undefined) return undefined;
  const matches = projects.filter((project) => project.id === projectId);
  if (environmentId === null || environmentId === undefined) {
    return matches.length === 1 ? matches[0] : undefined;
  }
  return matches.find((project) => project.environmentId === environmentId);
}

/**
 * Which environments a listing should ask, once the project scope is known. Scoping to a project
 * scopes to the server that owns it, saving every other server a read that could only answer with
 * nothing. Where an id is ambiguous — two servers holding the same project id, with no server
 * named — only the servers that actually hold that id are asked: a server without it may still
 * hold an unrelated project of its own under the same string, and asking it would return that
 * project's rows rather than an honest empty answer.
 */
export function resolveQueryEnvironmentIds<Id extends string>(
  environmentIds: ReadonlyArray<Id>,
  projects: ReadonlyArray<{ readonly id: string; readonly environmentId: Id }>,
  scopedProject: { readonly environmentId: Id } | undefined,
  scopedProjectId: string | undefined,
  projectsKnown: boolean,
): ReadonlyArray<Id> {
  if (scopedProject !== undefined) {
    return environmentIds.filter((environmentId) => environmentId === scopedProject.environmentId);
  }
  // Before the servers have said what they hold, an id nothing matches is an id nothing has been
  // asked about yet — reading none of them would show an empty page for a project that is there.
  if (scopedProjectId === undefined || !projectsKnown) return environmentIds;
  const holders = new Set(
    projects
      .filter((project) => project.id === scopedProjectId)
      .map((project) => project.environmentId),
  );
  return environmentIds.filter((environmentId) => holders.has(environmentId));
}

/**
 * The server a saved selection names, before its project is looked up against it. Still
 * connecting is not the same as gone: a server the workspace already knows about is kept named
 * here even while it has nothing to answer with yet, so the lookup that follows finds nothing
 * under it rather than falling through to a different server's project of the same id. Only a
 * name outside the workspace's whole catalog falls back to the page's own scope, which is what
 * lets a link to a server since removed still resolve by project id alone.
 */
export function resolveSelectedEnvironmentId<Id extends string>(
  namedEnvironmentId: Id | undefined,
  knownEnvironmentIds: ReadonlySet<Id>,
  fallbackEnvironmentId: Id | null,
): Id | null {
  if (namedEnvironmentId === undefined) return fallbackEnvironmentId;
  return knownEnvironmentIds.has(namedEnvironmentId) ? namedEnvironmentId : fallbackEnvironmentId;
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
export function rankPullRequestMatches<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  query: string,
): ReadonlyArray<Entry> {
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
export function withDiffStat<
  Entry extends PullRequestListEntry & { readonly environmentId: string },
>(
  entry: Entry,
  statsByRow: ReadonlyMap<string, { readonly additions: number; readonly deletions: number }>,
): Entry {
  if (entry.additions !== 0 || entry.deletions !== 0) return entry;
  const stat = statsByRow.get(diffStatKey(entry));
  return stat === undefined ? entry : { ...entry, ...stat };
}
