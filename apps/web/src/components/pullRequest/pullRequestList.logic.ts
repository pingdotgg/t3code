import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  PullRequestListEntry,
  PullRequestListProjectError,
  PullRequestListResult,
  resolvePullRequestAuthorFilter,
} from "@t3tools/contracts";
import type {
  ProjectId,
  RepositoryIdentity,
  PullRequestAction,
  PullRequestActor,
  PullRequestDiffStat,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListCursors,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestState,
} from "@t3tools/contracts";

import { toSortableTimestamp } from "../../lib/threadSort";
import type { PullRequestListSort } from "./pullRequestListPreferences";

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

export interface PullRequestAuthorFacet {
  readonly actor: PullRequestActor;
  readonly count: number;
  readonly mergedCount: number;
}

export interface PullRequestLabelFacet extends PullRequestLabel {
  readonly count: number;
}

export type PullRequestViewers = PullRequestListResult["viewers"];

type ScopedEntry = PullRequestListEntry & { readonly environmentId?: string };

const pullRequestViewerKey = (entry: ScopedEntry): string =>
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

export function pullRequestLabelColor(color: string | null): string | null {
  const hex = color?.trim().replace(/^#/, "") ?? "";
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

export function collectPullRequestListFacets(
  entries: ReadonlyArray<PullRequestListEntry>,
  state: PullRequestListState,
) {
  const authors = new Map<string, PullRequestAuthorFacet>();
  const labels = new Map<string, PullRequestLabelFacet>();
  const uniqueEntries = new Map(entries.map((entry) => [pullRequestEntryKey(entry), entry]));
  for (const entry of uniqueEntries.values()) {
    const inState = state === "all" || entry.state === state;
    if (entry.author !== null) {
      const key = normalize(entry.author.login);
      if (key !== null) {
        const held = authors.get(key);
        authors.set(key, {
          actor: held?.actor ?? entry.author,
          count: (held?.count ?? 0) + Number(inState),
          mergedCount: (held?.mergedCount ?? 0) + Number(entry.state === "merged"),
        });
      }
    }
    if (!inState) continue;
    for (const label of entry.labels) {
      const key = normalize(label.name);
      if (key === null) continue;
      const held = labels.get(key);
      labels.set(key, {
        ...label,
        name: held?.name ?? label.name,
        color: held?.color ?? label.color,
        count: (held?.count ?? 0) + 1,
      });
    }
  }
  return {
    authors: [...authors.values()]
      .filter((author) => author.count > 0)
      .toSorted(
        (left, right) =>
          right.mergedCount - left.mergedCount ||
          right.count - left.count ||
          left.actor.login.localeCompare(right.actor.login),
      ),
    labels: [...labels.values()].toSorted(
      (left, right) => right.count - left.count || left.name.localeCompare(right.name),
    ),
  };
}

/**
 * What a filter picker offers for `query`: the loaded rows that match keep their counts and lead,
 * then whatever the host found that no loaded row carries, so a name nobody has loaded yet is
 * still one search away.
 */
/** How many loaded matches come before the host's answers. */
const HOSTED_CHOICE_ROOM = 15;

export function pullRequestAuthorChoices(
  facets: ReadonlyArray<PullRequestAuthorFacet>,
  hosted: ReadonlyArray<PullRequestActor>,
  query: string,
): ReadonlyArray<PullRequestAuthorFacet> {
  const needle = normalize(query);
  const loaded = facets.filter(
    (facet) =>
      needle === null ||
      facet.actor.login.toLowerCase().includes(needle) ||
      facet.actor.name?.toLowerCase().includes(needle),
  );
  const known = new Map(facets.map((facet) => [normalize(facet.actor.login), facet]));
  const seen = new Set(loaded.map((facet) => normalize(facet.actor.login)));
  const added: PullRequestAuthorFacet[] = [];
  for (const actor of hosted) {
    const key = normalize(actor.login);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(known.get(key) ?? { actor, count: 0, mergedCount: 0 });
  }
  // The picker shows a short list, and loaded matches alone could fill it.
  return [...loaded.slice(0, HOSTED_CHOICE_ROOM), ...added, ...loaded.slice(HOSTED_CHOICE_ROOM)];
}

/**
 * The author a filter names, as a choice: an author picked from the host's answer is on no
 * loaded row, so it stays shown after the search that found it clears.
 */
export function selectedPullRequestAuthor(
  facets: ReadonlyArray<PullRequestAuthorFacet>,
  hosted: ReadonlyArray<PullRequestActor>,
  value: string | undefined,
): PullRequestAuthorFacet | undefined {
  if (value === undefined) return undefined;
  const key = normalize(value);
  return (
    facets.find((facet) => normalize(facet.actor.login) === key) ?? {
      actor: hosted.find((actor) => normalize(actor.login) === key) ?? {
        login: value,
        name: null,
        avatarUrl: null,
      },
      count: 0,
      mergedCount: 0,
    }
  );
}

export function pullRequestLabelChoices(
  facets: ReadonlyArray<PullRequestLabelFacet>,
  hosted: ReadonlyArray<PullRequestLabel>,
  query: string,
): ReadonlyArray<PullRequestLabelFacet> {
  const needle = normalize(query);
  const loaded = facets.filter(
    (facet) => needle === null || facet.name.toLowerCase().includes(needle),
  );
  const known = new Map(facets.map((facet) => [normalize(facet.name), facet]));
  const seen = new Set(loaded.map((facet) => normalize(facet.name)));
  const added: PullRequestLabelFacet[] = [];
  for (const label of hosted) {
    const key = normalize(label.name);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(known.get(key) ?? { ...label, count: 0 });
  }
  return [...loaded, ...added];
}

export function pullRequestEntryViewer(
  entry: ScopedEntry,
  viewers: PullRequestViewers,
): string | null {
  return normalize(viewers[pullRequestViewerKey(entry)] ?? viewers[entry.host]);
}

function isAuthoredByViewer(entry: ScopedEntry, viewers: PullRequestViewers): boolean {
  const viewer = pullRequestEntryViewer(entry, viewers);
  return viewer !== null && normalize(entry.author?.login) === viewer;
}

export function matchesPullRequestQuery(entry: PullRequestListEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return true;
  return `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(normalizedQuery);
}

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

export function matchesPullRequestFilters(
  entry: PullRequestListEntry,
  filters: PullRequestListFilters,
  viewer?: string | null,
): boolean {
  const labels = entry.labels.map((label) => label.name.trim().toLowerCase());
  const holds = (label: string) => labels.includes(label.trim().toLowerCase());
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
  return (["authored", "reviewRequested", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

export function pullRequestEntryKey(entry: ScopedEntry): string {
  const scope = entry.environmentId === undefined ? "" : `${entry.environmentId}:`;
  return `${scope}${entry.host}:${entry.repository}#${entry.number}`;
}

export interface PullRequestStatsTarget {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly refs: ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
    }>;
  };
}

export interface PullRequestStatsBatch extends PullRequestStatsTarget {
  readonly keys: ReadonlySet<string>;
}

export type PullRequestStatsPolicy = "visible" | "eager";

export interface PullRequestStatsScope {
  readonly key: string;
  readonly policy: PullRequestStatsPolicy;
}

const MAX_PULL_REQUEST_STATS_REFS = 500;

export function pullRequestStatsKeysToRequest(
  entriesByKey: ReadonlyMap<string, EnvironmentPullRequestEntry>,
  enteredKeys: ReadonlySet<string>,
  batches: ReadonlyArray<PullRequestStatsBatch>,
  statsByRow: ReadonlyMap<string, unknown>,
): ReadonlySet<string> {
  const requested = new Set(batches.flatMap((batch) => [...batch.keys]));
  return new Set(
    [...enteredKeys].filter((key) => {
      const entry = entriesByKey.get(key);
      return (
        entry !== undefined &&
        entry.additions === 0 &&
        entry.deletions === 0 &&
        !requested.has(key) &&
        !statsByRow.has(pullRequestDiffStatKey(entry))
      );
    }),
  );
}

export function pullRequestStatsBatches(
  entriesByKey: ReadonlyMap<string, EnvironmentPullRequestEntry>,
  keys: ReadonlySet<string>,
): ReadonlyArray<PullRequestStatsBatch> {
  const byEnvironment = new Map<
    EnvironmentId,
    Array<{
      readonly key: string;
      readonly ref: PullRequestStatsTarget["input"]["refs"][number];
    }>
  >();
  for (const key of keys) {
    const entry = entriesByKey.get(key);
    if (entry === undefined) continue;
    const rows = byEnvironment.get(entry.environmentId) ?? [];
    rows.push({
      key,
      ref: {
        projectId: entry.projectId,
        repository: entry.repository,
        number: entry.number,
      },
    });
    byEnvironment.set(entry.environmentId, rows);
  }
  return [...byEnvironment].flatMap(([environmentId, rows]) => {
    const batches: PullRequestStatsBatch[] = [];
    for (let index = 0; index < rows.length; index += MAX_PULL_REQUEST_STATS_REFS) {
      const batch = rows.slice(index, index + MAX_PULL_REQUEST_STATS_REFS);
      batches.push({
        environmentId,
        input: { refs: batch.map((row) => row.ref) },
        keys: new Set(batch.map((row) => row.key)),
      });
    }
    return batches;
  });
}

/** Size sorting needs all loaded rows' stats; other modes need only nearby rows. */
export function pullRequestStatsRequestBatches({
  entriesByKey,
  candidateKeys,
  policy,
  activeBatches,
  statsByRow,
  refresh = false,
}: {
  readonly entriesByKey: ReadonlyMap<string, EnvironmentPullRequestEntry>;
  readonly candidateKeys: ReadonlySet<string>;
  readonly policy: PullRequestStatsPolicy;
  readonly activeBatches: ReadonlyArray<PullRequestStatsBatch>;
  readonly statsByRow: ReadonlyMap<string, unknown>;
  readonly refresh?: boolean;
}): ReadonlyArray<PullRequestStatsBatch> {
  const requestedKeys = policy === "eager" ? new Set(entriesByKey.keys()) : candidateKeys;
  const keys = refresh
    ? requestedKeys
    : pullRequestStatsKeysToRequest(entriesByKey, requestedKeys, activeBatches, statsByRow);
  return pullRequestStatsBatches(entriesByKey, keys);
}

export function pullRequestStatsRefreshBatches({
  requestedScope,
  currentScope,
  entriesByKey,
  candidateKeys,
  statsByRow,
}: {
  readonly requestedScope: PullRequestStatsScope;
  readonly currentScope: PullRequestStatsScope;
  readonly entriesByKey: ReadonlyMap<string, EnvironmentPullRequestEntry>;
  readonly candidateKeys: ReadonlySet<string>;
  readonly statsByRow: ReadonlyMap<string, unknown>;
}): ReadonlyArray<PullRequestStatsBatch> | null {
  if (requestedScope.key !== currentScope.key || requestedScope.policy !== currentScope.policy) {
    return null;
  }
  return pullRequestStatsRequestBatches({
    entriesByKey,
    candidateKeys,
    policy: requestedScope.policy,
    activeBatches: [],
    statsByRow,
    refresh: true,
  });
}

export function retainVisiblePullRequestStatsBatches(
  batches: ReadonlyArray<PullRequestStatsBatch>,
  visibleKeys: ReadonlySet<string>,
): ReadonlyArray<PullRequestStatsBatch> {
  return batches.filter((batch) => {
    for (const key of batch.keys) {
      if (visibleKeys.has(key)) return true;
    }
    return false;
  });
}

/** Recency pagination can introduce older priority rows; grouping pages would reorder read rows. */
export function partitionPullRequestsWithPriority<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  authored: ReadonlyArray<Entry>,
  reviewRequested: ReadonlyArray<Entry>,
): ReadonlyArray<PullRequestGroup<Entry>> {
  const authoredByKey = new Map(authored.map((entry) => [pullRequestEntryKey(entry), entry]));
  const reviewByKey = new Map(
    reviewRequested.flatMap((entry) => {
      const key = pullRequestEntryKey(entry);
      return authoredByKey.has(key) ? [] : [[key, entry] as const];
    }),
  );
  const others: Entry[] = [];
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
  const byRecency = (left: Entry, right: Entry) => right.updatedAt.localeCompare(left.updatedAt);
  return (
    [
      { key: "authored", entries: [...authoredByKey.values()].toSorted(byRecency) },
      { key: "reviewRequested", entries: [...reviewByKey.values()].toSorted(byRecency) },
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

/** New stats queries must not blank existing counts. */
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
    next.set(pullRequestDiffStatKey(stat), {
      additions: stat.additions,
      deletions: stat.deletions,
    });
  }
  return next;
}

export const pullRequestDiffStatKey = (row: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly number: number;
}) => `${row.environmentId} ${row.projectId} ${row.number}`;

export interface MergedPullRequestList {
  readonly viewers: PullRequestViewers;
  readonly providers: PullRequestListResult["providers"];
  readonly entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  readonly errors: ReadonlyArray<EnvironmentPullRequestError>;
  readonly truncated: boolean;
  readonly nextCursors: Readonly<Record<string, PullRequestListCursors>>;
  readonly truncatedEnvironments: ReadonlyArray<string>;
}

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

const SNAPSHOT_MAX_ENTRIES = 99;

type SnapshotStorage = Pick<Storage, "getItem" | "setItem">;

export const pullRequestEnvironmentSetKey = (environmentIds: ReadonlyArray<string>): string =>
  [...environmentIds].sort((left, right) => left.localeCompare(right)).join(",");

const snapshotStorageKey = (environmentSetKey: string) =>
  `t3.pullRequests.list:${environmentSetKey}`;

export interface PullRequestPartitionsSnapshot {
  readonly authored: ReadonlyArray<EnvironmentPullRequestEntry>;
  readonly reviewing: ReadonlyArray<EnvironmentPullRequestEntry>;
}

export interface PullRequestListSnapshot {
  readonly scope: string;
  readonly data: MergedPullRequestList;
  readonly partitions?: PullRequestPartitionsSnapshot | undefined;
}

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
      nextCursors: Schema.Record(Schema.String, PullRequestListResult.fields.nextCursors),
      truncatedEnvironments: Schema.Array(Schema.String),
    }),
    partitions: Schema.optional(
      Schema.Struct({
        authored: Schema.Array(EnvironmentPullRequestEntrySchema),
        reviewing: Schema.Array(EnvironmentPullRequestEntrySchema),
      }),
    ),
  }),
);

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
          errors: [],
          nextCursors: {},
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
  } catch {}
}

/** Retain project scope during reconnect until projects arrive. */
export function resolveProjectScope<Id extends string>(
  projectId: Id | undefined,
  projects: ReadonlyArray<{ readonly id: string }>,
  projectsKnown: boolean,
): Id | undefined {
  if (projectId === undefined || !projectsKnown) return projectId;
  return projects.some((project) => project.id === projectId) ? projectId : undefined;
}

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
  if (scopedProjectId === undefined || !projectsKnown) return environmentIds;
  const holders = new Set(
    projects
      .filter((project) => project.id === scopedProjectId)
      .map((project) => project.environmentId),
  );
  return environmentIds.filter((environmentId) => holders.has(environmentId));
}

/** Retain connecting environments to avoid matching another server's project id. */
export function resolveSelectedEnvironmentId<Id extends string>(
  namedEnvironmentId: Id | undefined,
  knownEnvironmentIds: ReadonlySet<Id>,
  fallbackEnvironmentId: Id | null,
): Id | null {
  if (namedEnvironmentId === undefined) return fallbackEnvironmentId;
  return knownEnvironmentIds.has(namedEnvironmentId) ? namedEnvironmentId : fallbackEnvironmentId;
}

/** Host search also matches bodies and commits absent from visible row fields. */
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

export function rankPullRequestsByMergeReadiness<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  hasMeasuredSize: (entry: Entry) => boolean = (entry) => entry.additions + entry.deletions > 0,
): ReadonlyArray<Entry> {
  const tier = (entry: Entry) => {
    if (entry.mergeability === "conflicting") return 4;
    if (entry.state !== "open") return 3;
    if (entry.isDraft) return 2;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 0;
    if (entry.checksState === "passing") return 1;
    return 2;
  };
  return entries.toSorted((left, right) => {
    const byTier = tier(left) - tier(right);
    if (byTier !== 0) return byTier;
    const measured = Number(hasMeasuredSize(right)) - Number(hasMeasuredSize(left));
    const sized = left.additions + left.deletions - (right.additions + right.deletions);
    return measured || sized || right.updatedAt.localeCompare(left.updatedAt);
  });
}

function rankByTierThenRecency<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  tier: (entry: Entry) => number,
): ReadonlyArray<Entry> {
  const timestamp = (entry: Entry) => toSortableTimestamp(entry.updatedAt);
  return entries.toSorted((left, right) => {
    const byTier = tier(left) - tier(right);
    if (byTier !== 0) return byTier;
    const leftUpdated = timestamp(left);
    const rightUpdated = timestamp(right);
    const measured = Number(leftUpdated === null) - Number(rightUpdated === null);
    if (measured !== 0) return measured;
    if (leftUpdated === null || rightUpdated === null) return 0;
    return rightUpdated - leftUpdated;
  });
}

export function rankPullRequestsBlockedOnAuthor<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  return rankByTierThenRecency(entries, (entry) => {
    if (entry.state !== "open") return 6;
    if (entry.mergeability === "conflicting") return 0;
    if (entry.reviewDecision === "changes-requested") return 1;
    if (entry.checksState === "failing") return 2;
    if (entry.isDraft) return 3;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 5;
    return 4;
  });
}

function rankPullRequestsBlockedOnReviewer<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  return rankByTierThenRecency(entries, (entry) => (entry.state === "open" ? 0 : 1));
}

export function sortPullRequestGroups<Entry extends PullRequestListEntry>(
  groups: ReadonlyArray<PullRequestGroup<Entry>>,
  sort: PullRequestListSort,
  searchText: string,
  hasMeasuredSize: (entry: Entry) => boolean = (entry) => entry.additions + entry.deletions > 0,
  involvement: PullRequestInvolvement = "all",
): ReadonlyArray<PullRequestGroup<Entry>> {
  const sortWithinGroups = (rank: (entries: ReadonlyArray<Entry>) => ReadonlyArray<Entry>) =>
    groups.map((group) => ({ ...group, entries: rank(group.entries) }));

  if (sort === "ready") {
    return searchText.trim().length === 0
      ? sortWithinGroups((entries) => rankPullRequestsByMergeReadiness(entries, hasMeasuredSize))
      : groups;
  }
  if (sort === "blocked") {
    if (searchText.trim().length > 0) return groups;
    const role = (key: PullRequestGroupKey) =>
      key === "others" ? involvement : key === "authored" ? "authored" : "reviewing";
    return groups.map((group) => {
      const groupRole = role(group.key);
      if (groupRole === "all") return group;
      const rank =
        groupRole === "authored"
          ? rankPullRequestsBlockedOnAuthor
          : rankPullRequestsBlockedOnReviewer;
      return { ...group, entries: rank(group.entries) };
    });
  }
  if (sort === "updated") return groups;

  const timestamp = (entry: Entry) =>
    toSortableTimestamp(entry.updatedAt) ?? toSortableTimestamp(entry.createdAt) ?? 0;
  return sortWithinGroups((entries) =>
    entries.toSorted((left, right) => {
      if (sort === "newest" || sort === "oldest") {
        const leftCreated = toSortableTimestamp(left.createdAt);
        const rightCreated = toSortableTimestamp(right.createdAt);
        const measured = Number(rightCreated !== null) - Number(leftCreated !== null);
        const dated = (leftCreated ?? 0) - (rightCreated ?? 0);
        return (
          measured || (sort === "newest" ? -dated : dated) || timestamp(right) - timestamp(left)
        );
      }
      const measured = Number(hasMeasuredSize(right)) - Number(hasMeasuredSize(left));
      const sized = left.additions + left.deletions - (right.additions + right.deletions);
      return (
        measured || (sort === "largest" ? -sized : sized) || timestamp(right) - timestamp(left)
      );
    }),
  );
}

export function withDiffStat<
  Entry extends PullRequestListEntry & { readonly environmentId: string },
>(
  entry: Entry,
  statsByRow: ReadonlyMap<string, { readonly additions: number; readonly deletions: number }>,
): Entry {
  if (entry.additions !== 0 || entry.deletions !== 0) return entry;
  const stat = statsByRow.get(pullRequestDiffStatKey(entry));
  return stat === undefined ? entry : { ...entry, ...stat };
}

export interface PullRequestListOverride {
  readonly state: PullRequestState;
  readonly isDraft?: boolean;
  readonly updatedAt: string;
  readonly token: number;
  readonly at: number;
}

export function pullRequestOverrideAfterAction(
  entry: Pick<PullRequestListEntry, "state" | "isDraft">,
  action: PullRequestAction,
  now: Date,
  token: number,
): PullRequestListOverride | null {
  const stamp = { updatedAt: now.toISOString(), token, at: now.getTime() };
  switch (action) {
    case "close":
      return { state: "closed", ...stamp };
    case "reopen":
      return { state: "open", ...stamp };
    case "merge":
      return { state: "merged", ...stamp };
    case "draft":
      return { state: entry.state, isDraft: true, ...stamp };
    case "ready":
      return { state: entry.state, isDraft: false, ...stamp };
    default:
      return null;
  }
}

export function applyPullRequestOverrides<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  overrides: ReadonlyMap<string, PullRequestListOverride>,
  keyOf: (entry: Entry) => string,
  state: PullRequestListState,
): ReadonlyArray<Entry> {
  if (overrides.size === 0 && state === "all") return entries;
  const out: Entry[] = [];
  for (const entry of entries) {
    const override = overrides.get(keyOf(entry));
    if (state !== "all" && (override?.state ?? entry.state) !== state) continue;
    out.push(override === undefined ? entry : { ...entry, ...override });
  }
  return overrides.size === 0 && out.length === entries.length ? entries : out;
}

export function reusePullRequestEntries<Entry extends PullRequestListEntry>(
  previous: ReadonlyArray<Entry>,
  next: ReadonlyArray<Entry>,
  keyOf: (entry: Entry) => string,
): ReadonlyArray<Entry> {
  if (previous.length === 0) return next;
  const held = new Map(previous.map((entry) => [keyOf(entry), entry]));
  let reused = 0;
  const out = next.map((entry) => {
    const before = held.get(keyOf(entry));
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(entry)) {
      reused += 1;
      return before;
    }
    return entry;
  });
  return reused === next.length &&
    previous.length === next.length &&
    previous.every((entry, index) => keyOf(entry) === keyOf(next[index]!))
    ? previous
    : out;
}

const PULL_REQUEST_OVERRIDE_TRUST_MS = 60_000;

/** Retire overrides only when returned rows agree; partial-feed absence proves nothing. */
export function settlePullRequestOverrides<Entry extends PullRequestListEntry>(
  overrides: ReadonlyMap<string, PullRequestListOverride>,
  answered: ReadonlyArray<Entry>,
  keyOf: (entry: Entry) => string,
  now: number,
): ReadonlyMap<string, PullRequestListOverride> {
  if (overrides.size === 0) return overrides;
  const byKey = new Map(answered.map((entry) => [keyOf(entry), entry]));
  const kept = new Map<string, PullRequestListOverride>();
  for (const [key, override] of overrides) {
    const row = byKey.get(key);
    if (row === undefined) {
      kept.set(key, override);
      continue;
    }
    const agrees =
      row.state === override.state &&
      (override.isDraft === undefined || row.isDraft === override.isDraft);
    const outranked = now - override.at > PULL_REQUEST_OVERRIDE_TRUST_MS;
    if (!agrees && !outranked) kept.set(key, override);
  }
  return kept.size === overrides.size ? overrides : kept;
}

export type PullRequestQuickAction = "close" | "merge" | "ready" | "reopen";

export function pullRequestHostActions(
  providers: ReadonlyArray<PullRequestListResult["providers"][number]>,
): (
  entry: Pick<EnvironmentPullRequestEntry, "host" | "provider">,
) => ReadonlySet<PullRequestAction> {
  const byHost = new Map(
    providers.flatMap((provider) =>
      provider.actions === undefined
        ? []
        : [[provider.host.toLowerCase(), new Set(provider.actions)] as const],
    ),
  );
  const none = new Set<PullRequestAction>();
  return (entry) =>
    byHost.get(entry.host.toLowerCase()) ??
    sourceControlClients.find(entry.provider)?.changeRequestActionsWhenUnreported ??
    none;
}

export function pullRequestQuickActions(
  entry: Pick<EnvironmentPullRequestEntry, "state" | "isDraft">,
  hostActions: ReadonlySet<PullRequestAction>,
): ReadonlyArray<PullRequestQuickAction> {
  const forState: ReadonlyArray<PullRequestQuickAction> =
    entry.state === "merged"
      ? []
      : entry.state === "closed"
        ? ["reopen"]
        : entry.isDraft
          ? ["close", "ready"]
          : ["close", "merge"];
  return forState.filter((action) => hostActions.has(action));
}

export function largestPullRequestReadCount(
  entries: ReadonlyArray<EnvironmentPullRequestEntry>,
): number {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const read = `${entry.environmentId} ${entry.host.toLowerCase()} ${
      sourceControlClients.find(entry.provider)?.changeRequestListScope === "host"
        ? ""
        : entry.repository.toLowerCase()
    }`;
    counts.set(read, (counts.get(read) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

export function findProjectForRepository<
  Project extends {
    readonly id: string;
    readonly environmentId: string;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  },
>(
  projects: ReadonlyArray<Project>,
  input: {
    readonly repository: string;
    readonly host?: string | undefined;
    readonly selectedEnvironmentId?: string | null | undefined;
    readonly scopedProjectId?: string | undefined;
    readonly scopedEnvironmentId?: string | null | undefined;
  },
): Project | undefined {
  const repository = input.repository.toLowerCase();
  const host = input.host?.toLowerCase();
  const candidates = projects.filter((project) => {
    if (
      input.selectedEnvironmentId != null &&
      project.environmentId !== input.selectedEnvironmentId
    ) {
      return false;
    }
    const identity = project.repositoryIdentity;
    if (
      !identity ||
      sourceControlClients.repositorySelector(identity)?.toLowerCase() !== repository
    ) {
      return false;
    }
    return (
      host === undefined ||
      sourceControlClients.changeRequestHost(identity, identity.provider) === host
    );
  });
  // Azure repository names can collide across projects on the same host.
  const scoped = findScopedProject(candidates, input.scopedEnvironmentId, input.scopedProjectId);
  return scoped ?? candidates[0];
}
