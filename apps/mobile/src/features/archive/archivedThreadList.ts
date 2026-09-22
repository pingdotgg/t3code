import {
  archivedThreadActionKey as sharedArchivedThreadActionKey,
  tryAcquireArchivedThreadActionLock as acquireSharedArchivedThreadActionLock,
  archivedThreadSearchScore,
  archivedThreadSortTimestamp,
  compareArchivedThreads,
  type ArchivedThreadSearchInput,
  type ArchivedThreadSortState,
} from "@t3tools/client-runtime/state/archivedThreadList";
export {
  archivedThreadTimestampValue,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  releaseArchivedThreadActionLock,
  type ArchivedThreadSortField,
  type ArchivedThreadSortState,
} from "@t3tools/client-runtime/state/archivedThreadList";

import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  scopeProject,
  scopeThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { relativeTime } from "../../lib/time";

const DEFAULT_ARCHIVED_THREAD_ACTION_CONCURRENCY = 4;

export interface ArchivedThreadGroup {
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly searchScore: number;
}

export interface ArchivedThreadActionSummary {
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

export class ArchivedThreadActionError extends AggregateError {
  readonly summary: ArchivedThreadActionSummary;
  readonly totalCount: number;

  constructor(errors: Iterable<unknown>, summary: ArchivedThreadActionSummary, totalCount: number) {
    super(errors, "Archived thread action failed");
    this.name = "ArchivedThreadActionError";
    this.summary = summary;
    this.totalCount = totalCount;
  }
}

export type ArchivedThreadActionResult = "succeeded" | "failed" | "skipped";

export function archivedThreadActionKey(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): string {
  return sharedArchivedThreadActionKey({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
}

export function tryAcquireArchivedThreadActionLock(
  reservedThreadKeys: Set<string>,
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id">>,
) {
  return acquireSharedArchivedThreadActionLock(
    reservedThreadKeys,
    threads.map((thread) => ({ environmentId: thread.environmentId, threadId: thread.id })),
  );
}

export function archivedThreadActionSummaryDescription(
  summary: ArchivedThreadActionSummary,
): string {
  const parts = [`${summary.succeeded} succeeded`];
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.skipped > 0) {
    parts.push(`${summary.skipped} skipped because already in progress`);
  }
  return `${parts.length === 2 ? parts.join(" and ") : parts.join(", ").replace(/, ([^,]*)$/u, ", and $1")}.`;
}

export function archivedThreadActionExceptionDescription(error: unknown): string {
  const errors = error instanceof AggregateError ? error.errors : [error];
  const failureMessages = [
    ...new Set(
      errors.map((entry) => (entry instanceof Error ? entry.message : "An error occurred.")),
    ),
  ];
  const shownFailureMessages = failureMessages.slice(0, 3);
  const outcome =
    error instanceof ArchivedThreadActionError
      ? (() => {
          const notAttemptedCount = Math.max(
            0,
            error.totalCount -
              error.summary.succeeded -
              error.summary.failed -
              error.summary.skipped -
              error.errors.length,
          );
          const parts = [`${error.summary.succeeded} succeeded`];
          if (error.summary.failed > 0) parts.push(`${error.summary.failed} failed`);
          if (error.summary.skipped > 0) {
            parts.push(`${error.summary.skipped} skipped because already in progress`);
          }
          parts.push(
            `${error.errors.length} failed unexpectedly`,
            `${notAttemptedCount} not attempted`,
          );
          return `Partial outcome: ${parts.join(", ")}.`;
        })()
      : "One or more archived thread actions failed unexpectedly.";
  return [
    outcome,
    failureMessages.length <= 1
      ? (shownFailureMessages[0] ?? "An error occurred.")
      : `Failures: ${shownFailureMessages.join("; ")}${
          failureMessages.length > shownFailureMessages.length
            ? `; ${failureMessages.length - shownFailureMessages.length} more`
            : ""
        }`,
  ].join(" ");
}

function archivedProjectGroupKey(environmentId: EnvironmentId, projectId: string): string {
  return JSON.stringify([environmentId, projectId]);
}

export function formatArchivedThreadRelativeTime(input: string): string | null {
  return Number.isNaN(Date.parse(input)) ? null : relativeTime(input);
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
        key: archivedProjectGroupKey(project.environmentId, project.id),
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
      Order.Struct({
        timestamp: input.sort.direction === "asc" ? Order.Number : Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (group: ArchivedThreadGroup) => {
        let timestamp = archivedThreadSortTimestamp(group.threads[0]!, input.sort.field);
        for (let index = 1; index < group.threads.length; index += 1) {
          const candidate = archivedThreadSortTimestamp(group.threads[index]!, input.sort.field);
          timestamp =
            input.sort.direction === "asc"
              ? Math.min(timestamp, candidate)
              : Math.max(timestamp, candidate);
        }
        return {
          timestamp,
          title: group.project.title,
          key: group.key,
        };
      },
    ),
  );
}

export async function runArchivedThreadActions<T>(
  items: ReadonlyArray<T>,
  action: (item: T) => Promise<ArchivedThreadActionResult>,
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
  let skipped = 0;
  let shouldStop = false;

  async function worker() {
    for (;;) {
      if (shouldStop) return;
      const itemIndex = nextItemIndex;
      if (itemIndex >= items.length) return;
      nextItemIndex += 1;
      try {
        const result = await action(items[itemIndex]!);
        if (result === "succeeded") succeeded += 1;
        else if (result === "failed") failed += 1;
        else skipped += 1;
      } catch (error) {
        thrownErrors.push(error);
        shouldStop = true;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  if (thrownErrors.length > 0) {
    throw new ArchivedThreadActionError(thrownErrors, { succeeded, failed, skipped }, items.length);
  }
  return { succeeded, failed, skipped };
}
