import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schedule, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";
import { WorktreeCleanupJobRepositoryLive } from "../../persistence/Layers/WorktreeCleanupJobs.ts";
import {
  type WorktreeCleanupJob,
  WorktreeCleanupJobRepository,
} from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

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

export const findCanonicalActiveWorktreeOwner = Effect.fn("findCanonicalActiveWorktreeOwner")(
  function* (
    readModel: {
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly deletedAt: string | null;
        readonly worktreePath: string | null;
      }>;
    },
    deletedThreadId: ThreadId,
    canonicalWorktreePath: string,
  ) {
    const activeThreads = readModel.threads.flatMap((thread) =>
      thread.id !== deletedThreadId && thread.deletedAt === null && thread.worktreePath !== null
        ? [{ id: thread.id, worktreePath: thread.worktreePath }]
        : [],
    );
    const matches = yield* Effect.forEach(
      activeThreads,
      (thread) =>
        Effect.promise(() => canonicalizeWorktreePath(thread.worktreePath)).pipe(
          Effect.map((activePath) => activePath === canonicalWorktreePath),
        ),
      { concurrency: 4 },
    );
    const ownerIndex = matches.findIndex(Boolean);
    const owner = ownerIndex === -1 ? undefined : activeThreads[ownerIndex];
    return owner === undefined ? Option.none<ThreadId>() : Option.some(owner.id);
  },
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
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;

  const stopActiveProviderSession = Effect.fn("stopActiveProviderSession")(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    const sessions = yield* providerService.listSessions();
    if (!sessions.some((session) => session.threadId === threadId)) {
      return;
    }
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
          }>();
        }

        const cleanup = cleanupOption.value;
        const canonicalPath = yield* Effect.promise(() =>
          canonicalizeWorktreePath(cleanup.worktreePath),
        );
        const readModel = yield* orchestrationEngine.getReadModel();
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

        return Option.some({ cleanup, canonicalPath });
      }),
      ({ cleanup, canonicalPath }) =>
        Effect.gen(function* () {
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

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    if (event.payload.worktreeCleanup !== undefined) {
      yield* enqueueWorktreeCleanup(threadId);
      return;
    }
    yield* Effect.all([stopProviderSession(threadId), closeThreadTerminals(threadId)], {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
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

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

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
        if (event.type !== "thread.deleted") {
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
