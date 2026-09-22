import {
  archivedThreadSearchScore,
  compareArchivedThreads,
  type ArchivedThreadSortState,
} from "@t3tools/client-runtime/state/archivedThreadList";
export {
  archivedThreadActionKey,
  archivedThreadTimestampValue,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  releaseArchivedThreadActionLock,
  tryAcquireArchivedThreadActionLock,
  type ArchivedThreadSortField,
  type ArchivedThreadSortState,
} from "@t3tools/client-runtime/state/archivedThreadList";
import type {
  ContextMenuItem,
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";
import {
  resolveEnvironmentOptionLabel,
  shouldShowEnvironmentIndicator,
} from "../BranchToolbar.logic";
import type { ResolvedSettingsScope } from "./settingsScope";

export function scopeArchivedThreadSnapshots(
  snapshots: ReadonlyArray<ArchivedSnapshotEntry>,
  scope: Pick<ResolvedSettingsScope, "kind" | "environmentIds"> & {
    readonly members: ReadonlyArray<Pick<ArchivedThreadGroupProject, "id" | "environmentId">>;
  },
): ReadonlyArray<ArchivedSnapshotEntry> {
  const environmentIds = new Set(scope.environmentIds);
  const selectedProjects =
    scope.kind === "project" || scope.kind === "checkout"
      ? new Set(
          scope.members.map((member) => archivedProjectGroupKey(member.environmentId, member.id)),
        )
      : null;
  return snapshots
    .filter((entry) => environmentIds.has(entry.environmentId))
    .map((entry) => {
      if (selectedProjects === null) return entry;
      const projects = entry.snapshot.projects.filter((project) =>
        selectedProjects.has(archivedProjectGroupKey(entry.environmentId, project.id)),
      );
      const projectIds = new Set(projects.map((project) => project.id));
      return {
        ...entry,
        snapshot: {
          ...entry.snapshot,
          projects,
          threads: entry.snapshot.threads.filter((thread) => projectIds.has(thread.projectId)),
        },
      };
    });
}

const DEFAULT_ARCHIVED_PROJECT_BULK_ACTION_CONCURRENCY = 4;

export type ArchivedProjectBulkScope = "all" | "matching";
export type ArchivedThreadContextMenuId = "unarchive" | "delete";
export type ArchivedProjectContextMenuId = "unarchive-all" | "delete-all";

export type ArchivedProjectBulkThread = {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
};

export type ArchivedProjectBulkFailure = Extract<
  AtomCommandResult<unknown, unknown>,
  { readonly _tag: "Failure" }
>;

export type ArchivedThreadGroupProject = OrchestrationProjectShell & {
  readonly environmentId: EnvironmentId;
};

export type ArchivedThreadGroupThread = OrchestrationThreadShell & {
  readonly environmentId: EnvironmentId;
  readonly normalizedTitle: string;
  readonly searchScore: number;
};

export interface ArchivedThreadGroup {
  readonly key: string;
  readonly project: ArchivedThreadGroupProject;
  readonly threads: ReadonlyArray<ArchivedThreadGroupThread>;
  readonly searchScore: number;
}

export function buildArchivedThreadContextMenuItems(): ReadonlyArray<
  ContextMenuItem<ArchivedThreadContextMenuId>
> {
  return [
    { id: "unarchive", label: "Unarchive", icon: "archive-restore" },
    {
      id: "delete",
      label: "Delete",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export function buildArchivedProjectContextMenuItems(
  scope: ArchivedProjectBulkScope,
): ReadonlyArray<ContextMenuItem<ArchivedProjectContextMenuId>> {
  return [
    {
      id: "unarchive-all",
      label: scope === "matching" ? "Unarchive matching" : "Unarchive all",
      icon: "archive-restore",
    },
    {
      id: "delete-all",
      label: scope === "matching" ? "Delete matching" : "Delete all",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ArchivedProjectBulkActionOptions {
  readonly concurrency?: number;
}

export interface ArchivedProjectBulkActionSummary {
  readonly succeeded: number;
  readonly failures: ReadonlyArray<ArchivedProjectBulkFailure>;
}

export class ArchivedProjectBulkActionError extends AggregateError {
  readonly summary: ArchivedProjectBulkActionSummary;
  readonly totalCount: number;

  constructor(
    errors: Iterable<unknown>,
    summary: ArchivedProjectBulkActionSummary,
    totalCount: number,
  ) {
    super(errors, "Archived project thread action failed");
    this.name = "ArchivedProjectBulkActionError";
    this.summary = summary;
    this.totalCount = totalCount;
  }
}

function archivedProjectGroupKey(
  environmentId: EnvironmentId,
  projectId: OrchestrationProjectShell["id"],
): string {
  return JSON.stringify([environmentId, projectId]);
}

export function resolveArchivedProjectEnvironmentLabel(input: {
  readonly environment: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly isPrimary: boolean;
  } | null;
  readonly hasMultipleEnvironments: boolean;
}): string | null {
  if (
    !shouldShowEnvironmentIndicator({
      activeEnvironment: input.environment,
      canPickEnvironment: input.hasMultipleEnvironments,
    })
  ) {
    return null;
  }

  const environment = input.environment;
  if (environment === null) return null;
  return resolveEnvironmentOptionLabel({
    isPrimary: environment.isPrimary,
    environmentId: environment.environmentId,
    runtimeLabel: environment.label,
  });
}

export function hasArchivedThreads(snapshots: ReadonlyArray<ArchivedSnapshotEntry>): boolean {
  return snapshots.some(({ snapshot }) =>
    snapshot.threads.some((thread) => thread.archivedAt !== null),
  );
}

export async function runArchivedProjectThreadActions(
  threads: ReadonlyArray<ArchivedProjectBulkThread>,
  action: (thread: ArchivedProjectBulkThread) => Promise<AtomCommandResult<unknown, unknown>>,
  options: ArchivedProjectBulkActionOptions = {},
): Promise<ReadonlyArray<ArchivedProjectBulkFailure>> {
  const failures: Array<ArchivedProjectBulkFailure> = [];
  const thrownErrors: unknown[] = [];
  let succeeded = 0;
  const concurrency =
    options.concurrency === undefined || !Number.isFinite(options.concurrency)
      ? DEFAULT_ARCHIVED_PROJECT_BULK_ACTION_CONCURRENCY
      : Math.max(1, Math.floor(options.concurrency));
  let nextThreadIndex = 0;
  let shouldStop = false;
  async function worker() {
    for (;;) {
      if (shouldStop) {
        return;
      }
      const threadIndex = nextThreadIndex;
      if (threadIndex >= threads.length) {
        return;
      }
      nextThreadIndex += 1;
      const thread = threads[threadIndex]!;
      try {
        const result = await action(thread);
        if (result._tag === "Failure") {
          failures.push(result);
        } else {
          succeeded += 1;
        }
      } catch (error) {
        thrownErrors.push(error);
        shouldStop = true;
        return;
      }
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let index = 0; index < Math.min(concurrency, threads.length); index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (thrownErrors.length > 0) {
    throw new ArchivedProjectBulkActionError(thrownErrors, { succeeded, failures }, threads.length);
  }
  return failures;
}

export function archivedProjectBulkScopeLabel(scope: ArchivedProjectBulkScope): string {
  return scope === "matching" ? "matching archived conversations" : "all archived conversations";
}

export function archivedProjectBulkFailureDescription(
  failures: ReadonlyArray<ArchivedProjectBulkFailure>,
  totalCount: number,
): string | null {
  if (failures.length === 0) return null;
  const visibleFailures = failures.filter((failure) => !isAtomCommandInterrupted(failure));
  const interruptedCount = failures.length - visibleFailures.length;
  const successCount = totalCount - failures.length;
  const outcome = `${successCount} succeeded, ${visibleFailures.length} failed${
    interruptedCount > 0 ? `, ${interruptedCount} interrupted` : ""
  }.`;
  if (visibleFailures.length === 0) return outcome;

  const failureMessages = [
    ...new Set(
      visibleFailures.map((failure) => {
        const error = squashAtomCommandFailure(failure);
        return error instanceof Error ? error.message : "An error occurred.";
      }),
    ),
  ];
  const shownFailureMessages = failureMessages.slice(0, 3);
  const details =
    visibleFailures.length === 1
      ? (shownFailureMessages[0] ?? "An error occurred.")
      : `Failures: ${shownFailureMessages.join("; ")}${
          failureMessages.length > shownFailureMessages.length
            ? `; ${failureMessages.length - shownFailureMessages.length} more`
            : ""
        }`;
  return `${outcome} ${details}`;
}

export function archivedProjectBulkActionExceptionDescription(error: unknown): string {
  const errors = error instanceof AggregateError ? error.errors : [error];
  const commandFailures =
    error instanceof ArchivedProjectBulkActionError
      ? error.summary.failures
          .filter((failure) => !isAtomCommandInterrupted(failure))
          .map((failure) => squashAtomCommandFailure(failure))
      : [];
  const failureMessages = [
    ...new Set(
      [...errors, ...commandFailures].map((entry) =>
        entry instanceof Error ? entry.message : "An error occurred.",
      ),
    ),
  ];
  const shownFailureMessages = failureMessages.slice(0, 3);
  const outcome =
    error instanceof ArchivedProjectBulkActionError
      ? (() => {
          const visibleFailures = error.summary.failures.filter(
            (failure) => !isAtomCommandInterrupted(failure),
          );
          const interruptedCount = error.summary.failures.length - visibleFailures.length;
          const notAttemptedCount = Math.max(
            0,
            error.totalCount -
              error.summary.succeeded -
              error.summary.failures.length -
              error.errors.length,
          );
          const parts = [`${error.summary.succeeded} succeeded`];
          if (visibleFailures.length > 0) parts.push(`${visibleFailures.length} failed`);
          if (interruptedCount > 0) parts.push(`${interruptedCount} interrupted`);
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

export function buildArchivedThreadGroups(input: {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly normalizedSearchQuery: string;
  readonly searchTokens: ReadonlyArray<string>;
  readonly isSearching: boolean;
  readonly sort: ArchivedThreadSortState;
}): ReadonlyArray<ArchivedThreadGroup> {
  const projectsByEnvironmentAndId = new Map<string, ArchivedThreadGroupProject>();
  const threadsByEnvironmentAndProjectId = new Map<string, ArchivedThreadGroupThread[]>();

  for (const { environmentId, snapshot } of input.snapshots) {
    for (const project of snapshot.projects) {
      const key = archivedProjectGroupKey(environmentId, project.id);
      // Later snapshots for the same environment/project replace older project metadata.
      projectsByEnvironmentAndId.set(key, {
        ...project,
        environmentId,
      });
    }

    for (const thread of snapshot.threads) {
      if (thread.archivedAt === null) continue;
      const normalizedTitle = normalizeSearchQuery(thread.title);
      const searchScore = archivedThreadSearchScore({
        normalizedTitle,
        normalizedQuery: input.normalizedSearchQuery,
        tokens: input.searchTokens,
      });
      if (searchScore === null) {
        continue;
      }
      const key = archivedProjectGroupKey(environmentId, thread.projectId);
      const projectThreads = threadsByEnvironmentAndProjectId.get(key);
      const archivedThread = {
        ...thread,
        environmentId,
        normalizedTitle,
        searchScore,
      };
      if (projectThreads) {
        projectThreads.push(archivedThread);
      } else {
        threadsByEnvironmentAndProjectId.set(key, [archivedThread]);
      }
    }
  }

  const groups: ArchivedThreadGroup[] = [];
  for (const [projectKey, project] of projectsByEnvironmentAndId.entries()) {
    const projectThreads = threadsByEnvironmentAndProjectId.get(projectKey);
    if (projectThreads && projectThreads.length > 0) {
      const searchScore = projectThreads.reduce(
        (minimumScore, thread) => Math.min(minimumScore, thread.searchScore),
        Number.POSITIVE_INFINITY,
      );
      groups.push({
        key: projectKey,
        project,
        threads: projectThreads.toSorted((left, right) =>
          input.isSearching
            ? left.searchScore - right.searchScore ||
              compareArchivedThreads(left, right, input.sort)
            : compareArchivedThreads(left, right, input.sort),
        ),
        searchScore,
      });
    }
  }
  return input.isSearching
    ? groups.toSorted(
        (left, right) =>
          left.searchScore - right.searchScore ||
          left.project.title.localeCompare(right.project.title),
      )
    : groups;
}
