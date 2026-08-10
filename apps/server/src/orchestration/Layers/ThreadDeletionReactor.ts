import { CommandId, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schedule, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";
import { WorktreeCleanupJobRepositoryLive } from "../../persistence/Layers/WorktreeCleanupJobs.ts";
import {
  type WorktreeCleanupJob,
  WorktreeCleanupJobRepository,
} from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import {
  isRemovableArchiveWorktreePath,
  shouldScheduleArchiveWorktreeCleanup,
} from "../archiveWorktreeCleanup.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { findCanonicalActiveWorktreeOwner } from "../worktreeOwnership.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type ThreadArchivedEvent = Extract<OrchestrationEvent, { type: "thread.archived" }>;
type ThreadUnarchivedEvent = Extract<OrchestrationEvent, { type: "thread.unarchived" }>;
type ThreadCleanupLifecycleEvent = ThreadDeletedEvent | ThreadArchivedEvent | ThreadUnarchivedEvent;

const MAX_WORKTREE_CLEANUP_ATTEMPTS = 5;

export const processAfterWorktreeReservation = <A, E1, R1, E2, R2>(
  withLock: (
    effect: Effect.Effect<Option.Option<A>, E1, R1>,
  ) => Effect.Effect<Option.Option<A>, E1, R1>,
  reserve: Effect.Effect<Option.Option<A>, E1, R1>,
  process: (reservation: A) => Effect.Effect<void, E2, R2>,
): Effect.Effect<void, E1 | E2, R1 | R2> =>
  withLock(reserve).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: process,
      }),
    ),
  );

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

export const runAfterThreadRuntimeTeardown = <A, E1, R1, E2, R2, E3, R3>(
  stopProviderSession: Effect.Effect<void, E1, R1>,
  closeThreadTerminals: Effect.Effect<void, E2, R2>,
  effect: Effect.Effect<A, E3, R3>,
) =>
  Effect.gen(function* () {
    const [providerExit, terminalExit] = yield* Effect.all(
      [Effect.exit(stopProviderSession), Effect.exit(closeThreadTerminals)] as const,
      { concurrency: "unbounded" },
    );
    if (Exit.isFailure(providerExit)) {
      return yield* Effect.failCause(providerExit.cause);
    }
    if (Exit.isFailure(terminalExit)) {
      return yield* Effect.failCause(terminalExit.cause);
    }
    return yield* effect;
  });

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;
  const git = yield* GitCore;
  const gitManager = yield* GitManager;
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;

  const stopActiveProviderSession = Effect.fn("stopActiveProviderSession")(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    yield* providerService.stopSession({ threadId });
  });

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: stopActiveProviderSession(threadId),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminalsEffect = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    terminalManager.close({ threadId, deleteHistory: true });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: closeThreadTerminalsEffect(threadId),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const processWorktreeCleanup = Effect.fn("processWorktreeCleanup")(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    return yield* processAfterWorktreeReservation(
      orchestrationEngine.withWorktreeLock,
      Effect.gen(function* () {
        const cleanupOption = yield* worktreeCleanupJobs.getPendingByThreadId(threadId);
        if (Option.isNone(cleanupOption)) {
          return Option.none<{
            readonly cleanup: WorktreeCleanupJob;
            readonly canonicalPath: string;
            readonly siblingThreadIds: ReadonlyArray<WorktreeCleanupJob["threadId"]>;
          }>();
        }

        const cleanup = cleanupOption.value;
        const canonicalPath = yield* Effect.promise(() =>
          canonicalizeWorktreePath(cleanup.worktreePath),
        );
        const canonicalCwd = yield* Effect.promise(() => canonicalizeWorktreePath(cleanup.cwd));
        // Never remove the project's main checkout.
        if (canonicalPath === canonicalCwd) {
          yield* worktreeCleanupJobs.cancelByThreadId(cleanup.threadId);
          yield* Effect.logWarning("cancelled worktree cleanup for project workspace root", {
            threadId: cleanup.threadId,
            worktreePath: canonicalPath,
          });
          return Option.none();
        }

        const readModel = yield* orchestrationEngine.getReadModel();
        const cleanupThread = readModel.threads.find((thread) => thread.id === cleanup.threadId);
        // Archive cleanup can race unarchive: the job still names this thread, but
        // ownership checks exclude it. If the owner is active again, abort removal.
        const cleanupOwnerIsActive =
          cleanupThread !== undefined &&
          cleanupThread.deletedAt === null &&
          cleanupThread.archivedAt === null;
        if (cleanupOwnerIsActive) {
          yield* worktreeCleanupJobs.cancelByThreadId(cleanup.threadId);
          yield* Effect.logInfo("cancelled worktree cleanup after owner became active again", {
            threadId: cleanup.threadId,
            worktreePath: canonicalPath,
          });
          return Option.none();
        }

        const activeOwner = yield* findCanonicalActiveWorktreeOwner(
          readModel,
          cleanup.threadId,
          canonicalPath,
        );

        if (Option.isSome(activeOwner)) {
          yield* worktreeCleanupJobs.cancelByThreadId(cleanup.threadId);
          yield* Effect.logInfo("retained shared worktree after thread deletion", {
            threadId: cleanup.threadId,
            worktreePath: canonicalPath,
            activeOwnerThreadId: activeOwner.value,
          });
          return Option.none();
        }

        // Archive batches reserve cleanup on one thread only. Tear down every
        // inactive sibling that still points at this path before removal so a
        // shared checkout cannot be deleted under live providers/terminals.
        const siblingThreadIds = yield* Effect.forEach(
          readModel.threads.filter(
            (thread) =>
              thread.id !== cleanup.threadId &&
              thread.worktreePath !== null &&
              (thread.archivedAt !== null || thread.deletedAt !== null),
          ),
          (thread) =>
            Effect.promise(() => canonicalizeWorktreePath(thread.worktreePath!)).pipe(
              Effect.map((path) => (path === canonicalPath ? thread.id : null)),
            ),
          { concurrency: 4 },
        ).pipe(Effect.map((ids) => ids.filter((id): id is typeof cleanup.threadId => id !== null)));

        return Option.some({ cleanup, canonicalPath, siblingThreadIds });
      }),
      ({ cleanup, canonicalPath, siblingThreadIds }) =>
        Effect.gen(function* () {
          if (siblingThreadIds.length > 0) {
            yield* Effect.forEach(
              siblingThreadIds,
              (siblingThreadId) =>
                Effect.all(
                  [
                    stopActiveProviderSession(siblingThreadId),
                    closeThreadTerminalsEffect(siblingThreadId),
                  ] as const,
                  { concurrency: "unbounded", discard: true },
                ),
              { concurrency: 4, discard: true },
            );
          }

          const exists = yield* fileSystem.exists(canonicalPath);
          const outcome = !exists
            ? yield* git.pruneWorktrees(cleanup.cwd).pipe(Effect.as("removed" as const))
            : yield* git.statusDetailsLocal(canonicalPath).pipe(
                Effect.flatMap((status) =>
                  status.hasWorkingTreeChanges
                    ? Effect.succeed("retained-dirty" as const)
                    : git
                        .removeWorktree({
                          cwd: cleanup.cwd,
                          path: canonicalPath,
                        })
                        .pipe(Effect.as("removed" as const)),
                ),
              );

          if (outcome === "removed") {
            yield* worktreeCleanupJobs.deleteByThreadId(cleanup.threadId);
            yield* gitStatusBroadcaster
              .refreshStatus(cleanup.cwd)
              .pipe(Effect.ignoreCause({ log: true }));
            yield* Effect.logInfo("removed orphaned worktree after thread deletion", {
              threadId: cleanup.threadId,
              worktreePath: canonicalPath,
            });
            return;
          }

          yield* worktreeCleanupJobs.cancelByThreadId(cleanup.threadId);
          yield* Effect.logWarning("retained dirty worktree after thread deletion", {
            threadId: cleanup.threadId,
            worktreePath: canonicalPath,
          });
        }),
    );
  });

  const recordWorktreeCleanupFailure = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
    cause: Cause.Cause<unknown>,
  ) =>
    worktreeCleanupJobs
      .recordFailure({
        threadId,
        error: Cause.pretty(cause),
        maxAttempts: MAX_WORKTREE_CLEANUP_ATTEMPTS,
      })
      .pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (result) =>
              result.status === "cancelled"
                ? Effect.logError("worktree cleanup abandoned after repeated failures", {
                    threadId,
                    attemptCount: result.attemptCount,
                    cause: Cause.pretty(cause),
                  })
                : Effect.logWarning("worktree cleanup failed and will retry", {
                    threadId,
                    attemptCount: result.attemptCount,
                    cause: Cause.pretty(cause),
                  }),
          }),
        ),
        Effect.catch((recordError) =>
          Effect.logError("failed to record worktree cleanup failure", {
            threadId,
            cleanupCause: Cause.pretty(cause),
            recordError: recordError.message,
          }),
        ),
      );

  const queuedWorktreeCleanups = new Set<ThreadDeletedEvent["payload"]["threadId"]>();
  const worktreeCleanupWorker = yield* makeDrainableWorker(
    (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
      runAfterThreadRuntimeTeardown(
        stopActiveProviderSession(threadId),
        closeThreadTerminalsEffect(threadId),
        processWorktreeCleanup(threadId),
      ).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return recordWorktreeCleanupFailure(threadId, cause);
        }),
        Effect.ensuring(
          Effect.sync(() => {
            queuedWorktreeCleanups.delete(threadId);
          }),
        ),
      ),
  );
  const enqueueWorktreeCleanup = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (queuedWorktreeCleanups.has(threadId)) {
        return false;
      }
      queuedWorktreeCleanups.add(threadId);
      return true;
    }).pipe(
      Effect.flatMap((shouldEnqueue) =>
        shouldEnqueue ? worktreeCleanupWorker.enqueue(threadId) : Effect.void,
      ),
      Effect.uninterruptible,
    );

  const isWorktreeCleanupPendingForPath = Effect.fn("isWorktreeCleanupPendingForPath")(function* (
    worktreePath: string,
  ) {
    if (yield* worktreeCleanupJobs.existsByPath(worktreePath)) {
      return true;
    }
    const jobs = yield* worktreeCleanupJobs.list();
    return yield* Effect.forEach(
      jobs,
      (job) =>
        Effect.promise(() => canonicalizeWorktreePath(job.worktreePath)).pipe(
          Effect.map((pendingPath) => pendingPath === worktreePath),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((matches) => matches.some(Boolean)));
  });

  const cancelPendingCleanupForThreadAndPath = Effect.fn("cancelPendingCleanupForThreadAndPath")(
    function* (threadId: ThreadId, worktreePath: string | null) {
      yield* worktreeCleanupJobs.cancelByThreadId(threadId);
      if (worktreePath === null) {
        return;
      }
      const canonicalPath = yield* Effect.promise(() => canonicalizeWorktreePath(worktreePath));
      const jobs = yield* worktreeCleanupJobs.list();
      yield* Effect.forEach(
        jobs,
        (job) =>
          Effect.promise(() => canonicalizeWorktreePath(job.worktreePath)).pipe(
            Effect.flatMap((pendingPath) =>
              pendingPath === canonicalPath
                ? worktreeCleanupJobs.cancelByThreadId(job.threadId)
                : Effect.void,
            ),
          ),
        { concurrency: 4, discard: true },
      );
    },
  );

  const scheduleArchiveWorktreeCleanup = Effect.fn("scheduleArchiveWorktreeCleanup")(function* (
    threadId: ThreadId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread === undefined || thread.worktreePath === null || thread.pullRequest == null) {
      return;
    }
    const project = readModel.projects.find((entry) => entry.id === thread.projectId);
    if (project === undefined) {
      return;
    }

    const canonicalWorktreePath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(thread.worktreePath!),
    );
    const canonicalWorkspaceRoot = yield* Effect.promise(() =>
      canonicalizeWorktreePath(project.workspaceRoot),
    );
    if (
      !isRemovableArchiveWorktreePath({
        canonicalWorktreePath,
        canonicalWorkspaceRoot,
      })
    ) {
      yield* Effect.logInfo("skipped archive worktree cleanup for project workspace root", {
        threadId,
        worktreePath: canonicalWorktreePath,
      });
      return;
    }

    if (yield* isWorktreeCleanupPendingForPath(canonicalWorktreePath)) {
      return;
    }

    const hasActiveOwner = Option.isSome(
      yield* findCanonicalActiveWorktreeOwner(readModel, threadId, canonicalWorktreePath),
    );

    const resolved = yield* gitManager
      .resolvePullRequest({
        cwd: project.workspaceRoot,
        reference: String(thread.pullRequest.number),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("archive worktree cleanup skipped; failed to refresh PR state", {
            threadId,
            pullRequestNumber: thread.pullRequest?.number,
            error: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.as(null)),
        ),
      );
    if (resolved === null) {
      return;
    }

    if (
      !shouldScheduleArchiveWorktreeCleanup({
        pullRequestState: resolved.pullRequest.state,
        hasActiveOwner,
        isRemovableWorktreePath: true,
      })
    ) {
      return;
    }

    // Persist refreshed PR state so later reads don't keep a stale open state.
    if (thread.pullRequest.state !== resolved.pullRequest.state) {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
          pullRequest: {
            ...thread.pullRequest,
            state: resolved.pullRequest.state,
            title: resolved.pullRequest.title,
            url: resolved.pullRequest.url,
            baseBranch: resolved.pullRequest.baseBranch,
            headBranch: resolved.pullRequest.headBranch,
          },
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logDebug("failed to persist refreshed PR state after archive", {
              threadId,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    }

    yield* worktreeCleanupJobs
      .upsert({
        threadId,
        cwd: project.workspaceRoot,
        worktreePath: canonicalWorktreePath,
        requestedAt: new Date().toISOString(),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logDebug("archive worktree cleanup job not reserved", {
            threadId,
            worktreePath: canonicalWorktreePath,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    // Only enqueue when this thread still owns the pending reservation.
    const reserved = yield* worktreeCleanupJobs.getPendingByThreadId(threadId);
    if (Option.isNone(reserved)) {
      return;
    }
    yield* enqueueWorktreeCleanup(threadId);
    yield* Effect.logInfo("scheduled archive worktree cleanup after live PR refresh", {
      threadId,
      worktreePath: canonicalWorktreePath,
      pullRequestState: resolved.pullRequest.state,
    });
  });

  const processThreadUnarchived = Effect.fn("processThreadUnarchived")(function* (
    event: ThreadUnarchivedEvent,
  ) {
    const { threadId } = event.payload;
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    const worktreePath = thread?.worktreePath ?? null;
    yield* cancelPendingCleanupForThreadAndPath(threadId, worktreePath);

    if (worktreePath === null) {
      return;
    }
    const canonicalPath = yield* Effect.promise(() => canonicalizeWorktreePath(worktreePath));
    const stillExists = yield* fileSystem.exists(canonicalPath);
    if (stillExists) {
      return;
    }

    // Clear the orchestration read model via a domain event so later bindings
    // don't treat a missing path as still owned by this thread.
    yield* orchestrationEngine
      .dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(crypto.randomUUID()),
        threadId,
        worktreePath: null,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to clear missing worktreePath after unarchive", {
            threadId,
            worktreePath: canonicalPath,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
  });

  const processThreadLifecycleEvent = Effect.fn("processThreadLifecycleEvent")(function* (
    event: ThreadCleanupLifecycleEvent,
  ) {
    if (event.type === "thread.unarchived") {
      yield* processThreadUnarchived(event);
      return;
    }

    const { threadId } = event.payload;
    if (event.type === "thread.deleted" && event.payload.worktreeCleanup !== undefined) {
      // Cleanup worker tears down this thread, then any inactive path siblings,
      // before removing the checkout.
      yield* enqueueWorktreeCleanup(threadId);
      return;
    }

    // Always tear down archived/deleted threads, even without a cleanup reservation.
    // Otherwise a sibling that reserved cleanup can delete a shared checkout
    // while this thread's provider/terminals are still attached.
    yield* Effect.all([stopProviderSession(threadId), closeThreadTerminals(threadId)], {
      concurrency: "unbounded",
      discard: true,
    });

    if (event.type === "thread.archived") {
      // Live-refresh PR state: associations are usually stored while open.
      yield* scheduleArchiveWorktreeCleanup(threadId);
    }
  });

  const processThreadLifecycleEventSafely = (event: ThreadCleanupLifecycleEvent) =>
    processThreadLifecycleEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadLifecycleEventSafely);

  const enqueuePendingWorktreeCleanups = worktreeCleanupJobs.list().pipe(
    Effect.flatMap((jobs) =>
      Effect.forEach(jobs, (job) => enqueueWorktreeCleanup(job.threadId), {
        concurrency: 1,
        discard: true,
      }),
    ),
    Effect.catch((error) =>
      Effect.logWarning("failed to restore pending worktree cleanup jobs", {
        error: error.message,
      }),
    ),
  );

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      enqueuePendingWorktreeCleanups.pipe(Effect.repeat(Schedule.spaced("60 seconds"))),
    );
    yield* Effect.forkScoped(
      orchestrationEngine.getReadModel().pipe(
        Effect.flatMap((readModel) =>
          Effect.forEach(
            new Set(
              readModel.projects
                .filter((project) => project.deletedAt === null)
                .map((project) => project.workspaceRoot),
            ),
            (cwd) =>
              git.pruneWorktrees(cwd).pipe(
                Effect.catch((error) =>
                  Effect.logDebug("worktree registration prune skipped", {
                    cwd,
                    error: error.message,
                  }),
                ),
              ),
            { concurrency: 4, discard: true },
          ),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.deleted" &&
          event.type !== "thread.archived" &&
          event.type !== "thread.unarchived"
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(Effect.andThen(worktreeCleanupWorker.drain)),
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make).pipe(
  Layer.provideMerge(WorktreeCleanupJobRepositoryLive),
);
