import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  scopeProject,
  scopeThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";

const ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET = 1_000;
const ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET = 5_000;
const DEFAULT_ARCHIVED_THREAD_ACTION_CONCURRENCY = 4;

export type ArchivedThreadSortField = "archivedAt" | "createdAt";
export type ArchivedThreadSortDirection = "asc" | "desc";

export interface ArchivedThreadSortState {
  readonly field: ArchivedThreadSortField;
  readonly direction: ArchivedThreadSortDirection;
}

export interface ArchivedThreadSearchInput {
  readonly normalizedQuery: string;
  readonly tokens: ReadonlyArray<string>;
  readonly isSearching: boolean;
}

export interface ArchivedThreadGroup {
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly searchScore: number;
}

export interface ArchivedThreadActionSummary {
  readonly succeeded: number;
  readonly failed: number;
}

function archivedThreadTimestamp(
  thread: Pick<EnvironmentThreadShell, "archivedAt" | "createdAt">,
  field: ArchivedThreadSortField,
): number {
  const timestamp = Date.parse(
    field === "archivedAt" ? (thread.archivedAt ?? thread.createdAt) : thread.createdAt,
  );
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function formatArchivedThreadRelativeTime(input: string): string | null {
  return Number.isNaN(Date.parse(input)) ? null : relativeTime(input);
}

export function parseArchivedThreadSearchInput(query: string): ArchivedThreadSearchInput {
  const normalizedQuery = normalizeSearchQuery(query);
  return {
    normalizedQuery,
    tokens: normalizedQuery.split(/\s+/u).filter((token) => token.length > 0),
    isSearching: normalizedQuery.length > 0,
  };
}

// Lower scores are more relevant, matching the shared search-ranking helpers.
export function archivedThreadSearchScore(input: {
  readonly normalizedTitle: string;
  readonly normalizedQuery: string;
  readonly tokens: ReadonlyArray<string>;
}): number | null {
  if (input.normalizedQuery.length === 0) return 0;
  if (!input.normalizedTitle) return null;

  const phraseScore = scoreQueryMatch({
    value: input.normalizedTitle,
    query: input.normalizedQuery,
    exactBase: 0,
    prefixBase: 1,
    boundaryBase: 2,
    includesBase: 3,
  });
  if (phraseScore !== null) return phraseScore;

  let matchedTokenCount = 0;
  let tokenScore = 0;
  for (const token of input.tokens) {
    const score = scoreQueryMatch({
      value: input.normalizedTitle,
      query: token,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      ...(token.length >= 3 ? { fuzzyBase: 100 } : {}),
    });
    if (score === null) continue;
    matchedTokenCount += 1;
    tokenScore += score;
  }

  if (matchedTokenCount === 0) return null;
  if (matchedTokenCount === input.tokens.length) {
    return ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET + tokenScore;
  }
  return (
    ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET +
    (input.tokens.length - matchedTokenCount) * 1_000 +
    tokenScore
  );
}

export function compareArchivedThreads(
  left: EnvironmentThreadShell,
  right: EnvironmentThreadShell,
  sort: ArchivedThreadSortState,
): number {
  const leftTimestamp = archivedThreadTimestamp(left, sort.field);
  const rightTimestamp = archivedThreadTimestamp(right, sort.field);
  const timestampComparison =
    sort.direction === "asc" ? leftTimestamp - rightTimestamp : rightTimestamp - leftTimestamp;
  return timestampComparison || left.id.localeCompare(right.id);
}

export function nextArchivedThreadSortState(
  current: ArchivedThreadSortState,
  field: ArchivedThreadSortField,
): ArchivedThreadSortState {
  if (current.field !== field) return { field, direction: "desc" };
  return { field, direction: current.direction === "desc" ? "asc" : "desc" };
}

export function buildArchivedThreadGroups(input: {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly environmentId: EnvironmentId | null;
  readonly search: ArchivedThreadSearchInput;
  readonly sort: ArchivedThreadSortState;
}): ReadonlyArray<ArchivedThreadGroup> {
  const groups: ArchivedThreadGroup[] = [];

  for (const entry of input.snapshots) {
    if (input.environmentId !== null && input.environmentId !== entry.environmentId) continue;

    const threadsByProjectId = new Map<
      string,
      Array<{ readonly thread: EnvironmentThreadShell; readonly searchScore: number }>
    >();
    for (const rawThread of entry.snapshot.threads) {
      if (rawThread.archivedAt === null) continue;
      const searchScore = archivedThreadSearchScore({
        normalizedTitle: normalizeSearchQuery(rawThread.title),
        normalizedQuery: input.search.normalizedQuery,
        tokens: input.search.tokens,
      });
      if (searchScore === null) continue;
      const threads = threadsByProjectId.get(rawThread.projectId) ?? [];
      threads.push({ thread: scopeThreadShell(entry.environmentId, rawThread), searchScore });
      threadsByProjectId.set(rawThread.projectId, threads);
    }

    for (const rawProject of entry.snapshot.projects) {
      const project = scopeProject(entry.environmentId, rawProject);
      const projectThreads = threadsByProjectId.get(project.id);
      if (!projectThreads || projectThreads.length === 0) continue;
      const searchScore = projectThreads.reduce(
        (minimum, entry) => Math.min(minimum, entry.searchScore),
        Number.POSITIVE_INFINITY,
      );
      groups.push({
        key: scopedProjectKey(project.environmentId, project.id),
        project,
        threads: projectThreads
          .sort((left, right) =>
            input.search.isSearching
              ? left.searchScore - right.searchScore ||
                compareArchivedThreads(left.thread, right.thread, input.sort)
              : compareArchivedThreads(left.thread, right.thread, input.sort),
          )
          .map((entry) => entry.thread),
        searchScore,
      });
    }
  }

  if (input.search.isSearching) {
    return groups.sort(
      (left, right) =>
        left.searchScore - right.searchScore ||
        left.project.title.localeCompare(right.project.title),
    );
  }

  return Arr.sort(
    groups,
    Order.mapInput(
      Order.Struct({ timestamp: Order.flip(Order.Number), title: Order.String, key: Order.String }),
      (group: ArchivedThreadGroup) => ({
        timestamp: Math.max(
          ...group.threads.map((thread) => archivedThreadTimestamp(thread, "archivedAt")),
        ),
        title: group.project.title,
        key: group.key,
      }),
    ),
  );
}

export async function runArchivedThreadActions<T>(
  items: ReadonlyArray<T>,
  action: (item: T) => Promise<boolean>,
  options: { readonly concurrency?: number } = {},
): Promise<ArchivedThreadActionSummary> {
  const concurrency =
    options.concurrency === undefined || !Number.isFinite(options.concurrency)
      ? DEFAULT_ARCHIVED_THREAD_ACTION_CONCURRENCY
      : Math.max(1, Math.floor(options.concurrency));
  const thrownErrors: unknown[] = [];
  let nextItemIndex = 0;
  let succeeded = 0;
  let failed = 0;
  let shouldStop = false;

  async function worker() {
    for (;;) {
      if (shouldStop) return;
      const itemIndex = nextItemIndex;
      if (itemIndex >= items.length) return;
      nextItemIndex += 1;
      try {
        if (await action(items[itemIndex]!)) succeeded += 1;
        else failed += 1;
      } catch (error) {
        thrownErrors.push(error);
        shouldStop = true;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  if (thrownErrors.length > 0) {
    throw new AggregateError(thrownErrors, "Archived thread action failed");
  }
  return { succeeded, failed };
}
