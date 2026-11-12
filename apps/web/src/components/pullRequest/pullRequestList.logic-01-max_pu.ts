import { GROUP_LABELS, pullRequestEntryKey } from "./pullRequestList.logic-02-environment.ts";
import type { EnvironmentPullRequestEntry, EnvironmentPullRequestError, MergedPullRequestList, PullRequestDiffStats, PullRequestGroup, PullRequestGroupKey, PullRequestListOverride, PullRequestQuickAction, PullRequestStatsBatch, PullRequestStatsPolicy, PullRequestStatsScope, PullRequestStatsTarget } from "./pullRequestList.logic-02-environment.ts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  EnvironmentId,
  PullRequestListEntry,
  PullRequestListProjectError,
  PullRequestListResult,
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
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { PullRequestListSort } from "./pullRequestListPreferences";

export const MAX_PULL_REQUEST_STATS_REFS = 500;

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
  return (
    [
      {
        key: "authored",
        entries: [...authoredByKey.values()].toSorted(comparePullRequestsByRecency),
      },
      {
        key: "reviewRequested",
        entries: [...reviewByKey.values()].toSorted(comparePullRequestsByRecency),
      },
      { key: "others", entries: others },
    ] as const
  )
    .filter((group) => group.entries.length > 0)
    .map((group) => ({ ...group, label: GROUP_LABELS[group.key] }));
}

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
    entries: entries.toSorted(comparePullRequestsByRecency),
    errors,
    truncated,
    nextCursors,
    truncatedEnvironments,
  };
}

export const pullRequestEnvironmentSetKey = (environmentIds: ReadonlyArray<string>): string =>
  [...environmentIds].sort((left, right) => left.localeCompare(right)).join(",");

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
    return byScore !== 0 ? byScore : comparePullRequestsByRecency(left, right);
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
    return measured || sized || comparePullRequestsByRecency(left, right);
  });
}

export function comparePullRequestsByRecency(
  left: PullRequestListEntry,
  right: PullRequestListEntry,
) {
  const leftUpdated = toSortableTimestamp(left.updatedAt);
  const rightUpdated = toSortableTimestamp(right.updatedAt);
  const measured = Number(leftUpdated === null) - Number(rightUpdated === null);
  if (measured !== 0) return measured;
  if (leftUpdated === null || rightUpdated === null) return 0;
  return rightUpdated - leftUpdated;
}

export function rankByTierThenRecency<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  tier: (entry: Entry) => number,
): ReadonlyArray<Entry> {
  return entries.toSorted((left, right) => {
    const byTier = tier(left) - tier(right);
    return byTier !== 0 ? byTier : comparePullRequestsByRecency(left, right);
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

export function rankPullRequestsBlockedOnReviewer<Entry extends PullRequestListEntry>(
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

export const PULL_REQUEST_OVERRIDE_TRUST_MS = 60_000;

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

