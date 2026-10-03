import {
  CommandId,
  type GitResolvePullRequestResult,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
} from "@t3tools/contracts";
import path from "node:path";

import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { sameThreadPullRequest, threadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import { Cause, Clock, Effect, Exit, FileSystem, Layer, Option, Schedule, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckoutCoordinator, CheckoutCoordinatorLive } from "../../git/CheckoutCoordinator.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";
import { WorktreeCleanupJobRepositoryLive } from "../../persistence/Layers/WorktreeCleanupJobs.ts";
import {
  type WorktreeCleanupJob,
  WorktreeCleanupJobRepository,
} from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { WorkspaceOwnershipRepository } from "../../persistence/Services/WorkspaceOwnership.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { isRemovableArchiveWorktreePath } from "../archiveWorktreeCleanup.ts";
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
type PullRequestRefreshCandidate = {
  readonly thread: OrchestrationReadModel["threads"][number];
  readonly link: NonNullable<OrchestrationReadModel["threads"][number]["pullRequests"]>[number];
};

export type PullRequestRefreshGroup = {
  readonly cwds: ReadonlyArray<string>;
  readonly pullRequest: PullRequestRefreshCandidate["link"]["pullRequest"];
  readonly candidates: ReadonlyArray<PullRequestRefreshCandidate>;
};

export function resolvePullRequestFromCwds(
  cwds: ReadonlyArray<string>,
  reference: string,
  resolvePullRequest: GitManagerShape["resolvePullRequest"],
): Effect.Effect<GitResolvePullRequestResult | null, never> {
  const cwd = cwds[0];
  if (!cwd) {
    return Effect.succeed(null);
  }
  return resolvePullRequest({ cwd, reference }).pipe(
    Effect.catch((error) =>
      Effect.logDebug("pull request association resolver failed for checkout", {
        cwd,
        reference,
        error: error instanceof Error ? error.message : String(error),
      }).pipe(
        Effect.andThen(resolvePullRequestFromCwds(cwds.slice(1), reference, resolvePullRequest)),
      ),
    ),
  );
}

const MAX_WORKTREE_CLEANUP_ATTEMPTS = 5;
const CLEANUP_RECONCILIATION_INTERVAL = "5 minutes";
const CLEANUP_DUE_SWEEP_INTERVAL = "1 minute";

/** Sibling directory that holds detached worktrees until their bytes are deleted. */
export function worktreeTrashDirectory(canonicalWorktreePath: string): string {
  return path.join(path.dirname(canonicalWorktreePath), ".t3-worktree-trash");
}

export function groupOpenPullRequestAssociationRefreshes(
  readModel: OrchestrationReadModel,
): ReadonlyArray<PullRequestRefreshGroup> {
  const projectsById = new Map(
    readModel.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => [project.id, project] as const),
  );
  const candidates = readModel.threads.flatMap((thread) => {
    if (thread.deletedAt !== null || thread.archivedAt !== null) return [];
    const links =
      thread.pullRequests ??
      (thread.pullRequest
        ? [
            {
              pullRequest: thread.pullRequest,
              source: "manual" as const,
              linkedAt: thread.updatedAt,
            },
          ]
        : []);
    return links
      .filter((link) => link.pullRequest.state !== "merged")
      .map((link) => ({ thread, link }));
  });
  const groups = new Map<string, Array<PullRequestRefreshCandidate>>();
  for (const candidate of candidates) {
    const project = projectsById.get(candidate.thread.projectId);
    if (!project) continue;
    const key = threadPullRequestKey(candidate.link.pullRequest);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    if (!first) return [];
    const cwds = [
      ...new Set(
        group.flatMap((candidate) => {
          const candidateProject = projectsById.get(candidate.thread.projectId);
          return [
            ...(candidate.thread.worktreePath ? [candidate.thread.worktreePath] : []),
            ...(candidateProject ? [candidateProject.workspaceRoot] : []),
          ];
        }),
      ),
    ];
    return [
      {
        cwds,
        pullRequest: first.link.pullRequest,
        candidates: group,
      },
    ];
  });
}

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
  const checkoutCoordinator = yield* CheckoutCoordinator;
  const gitManager = yield* GitManager;
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const worktreeCleanupJobs = yield* WorktreeCleanupJobRepository;
  const workspaceOwnership = yield* WorkspaceOwnershipRepository;

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

  // Runs outside every lock: the checkout is already detached from Git, so a
  // failure only leaves bytes for the startup trash sweep to reclaim.
  const deleteDetachedWorktree = (detachedPath: string) =>
    fileSystem.remove(detachedPath, { recursive: true, force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete detached worktree; startup sweep will retry", {
          detachedPath,
          error: error.message,
        }),
      ),
    );

  const sweepWorktreeTrash = Effect.gen(function* () {
    const jobs = yield* worktreeCleanupJobs.list();
    const trashDirectories = new Set(
      jobs.map((job) => worktreeTrashDirectory(job.canonicalWorktreePath)),
    );
    yield* Effect.forEach(
      trashDirectories,
      (trashDirectory) =>
        fileSystem.readDirectory(trashDirectory).pipe(
          Effect.catch(() => Effect.succeed([] as Array<string>)),
          // Only entries present now: concurrent cleanups detach under fresh names.
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries,
              (entry) => deleteDetachedWorktree(path.join(trashDirectory, entry)),
              { concurrency: 1, discard: true },
            ),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("worktree trash sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: closeThreadTerminalsEffect(threadId),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const releaseThreadOwnership = Effect.fn("releaseThreadOwnership")(function* (
    threadId: ThreadId,
  ) {
    const ownerships = yield* workspaceOwnership.getByThreadId(threadId);
    yield* Effect.forEach(
      ownerships,
      (ownership) => workspaceOwnership.release(threadId, ownership.canonicalPath),
      { concurrency: 1, discard: true },
    );
  });

  const cleanupNow = Effect.fn("cleanupNow")(function* () {
    return new Date(yield* Clock.currentTimeMillis).toISOString();
  });

  const cleanupRetryAt = Effect.fn("cleanupRetryAt")(function* (attemptCount: number) {
    const delaySeconds = Math.min(30 * 60, 60 * 2 ** Math.min(attemptCount, 5));
    return new Date((yield* Clock.currentTimeMillis) + delaySeconds * 1000).toISOString();
  });

  const deferCleanup = Effect.fn("deferCleanup")(function* (
    threadId: ThreadId,
    reason: string,
    error?: string,
    attemptCount = 0,
  ) {
    yield* worktreeCleanupJobs.defer({
      threadId,
      reason,
      error,
      nextAttemptAt: yield* cleanupRetryAt(attemptCount),
    });
  });

  const inspectRegisteredWorktree = Effect.fn("inspectRegisteredWorktree")(function* (
    cleanup: WorktreeCleanupJob,
  ) {
    const branches = yield* checkoutCoordinator.withCheckout(
      cleanup.cwd,
      git.listRegisteredWorktrees(cleanup.cwd),
    );
    if (!branches.isRepo) {
      return { isRepo: false, registered: false, branchName: null };
    }
    const registeredWorktrees = yield* Effect.forEach(
      branches.worktrees,
      ({ branch, path }) =>
        Effect.promise(() => canonicalizeWorktreePath(path)).pipe(
          Effect.map((canonicalPath) => ({ branch, path: canonicalPath })),
        ),
      { concurrency: 4 },
    );
    const registeredWorktree = registeredWorktrees.find(
      ({ path }) => path === cleanup.canonicalWorktreePath,
    );
    return {
      isRepo: true,
      registered: registeredWorktree !== undefined,
      branchName: registeredWorktree?.branch ?? null,
    };
  });

  const reconcileCleanupIntent = Effect.fn("reconcileCleanupIntent")(function* (
    threadId: ThreadId,
  ) {
    const cleanupOption = yield* worktreeCleanupJobs.getByThreadId(threadId);
    if (Option.isNone(cleanupOption) || cleanupOption.value.status !== "waiting") {
      return false;
    }
    const cleanup = cleanupOption.value;
    const now = yield* cleanupNow();
    if (cleanup.nextAttemptAt !== null && cleanup.nextAttemptAt > now) {
      return false;
    }
    if (cleanup.source === "legacy") {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "legacy-cleanup-intent-requires-review",
      });
      return false;
    }

    const canonicalPath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(cleanup.worktreePath),
    );
    if (canonicalPath !== cleanup.canonicalWorktreePath) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "canonical-path-changed",
      });
      return false;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const cleanupThread = readModel.threads.find((thread) => thread.id === threadId);
    const project = cleanupThread
      ? readModel.projects.find((entry) => entry.id === cleanupThread.projectId)
      : readModel.projects.find(
          (entry) => entry.workspaceRoot === cleanup.cwd && entry.deletedAt === null,
        );
    if (project === undefined || project.deletedAt !== null) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: project === undefined ? "project-not-found" : "project-deleted",
      });
      return false;
    }

    const canonicalWorkspaceRoot = yield* Effect.promise(() =>
      canonicalizeWorktreePath(cleanup.cwd),
    );
    if (
      !isRemovableArchiveWorktreePath({
        canonicalWorktreePath: cleanup.canonicalWorktreePath,
        canonicalWorkspaceRoot,
      })
    ) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "project-workspace-root",
      });
      return false;
    }

    if (cleanup.source === "archive") {
      if (cleanupThread?.deletedAt !== null && cleanupThread !== undefined) {
        yield* worktreeCleanupJobs.markNeedsAttention({
          threadId,
          reason: "archived-thread-was-deleted",
        });
        return false;
      }
      if (cleanupThread?.archivedAt === null || cleanupThread === undefined) {
        yield* worktreeCleanupJobs.cancelByThreadId(threadId);
        return false;
      }
      // Pull request state is deliberately irrelevant: removal keeps the
      // branch ref (so commits survive), refuses dirty or untracked work, and
      // unarchive restores the checkout from that branch.
    }

    const registration = yield* inspectRegisteredWorktree(cleanup);
    const exists = yield* fileSystem.exists(cleanup.canonicalWorktreePath);
    if (!registration.isRepo) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "repository-unavailable",
      });
      return false;
    }
    if (!registration.registered && !exists) {
      yield* worktreeCleanupJobs.markCompletedWithoutRemoval({ threadId });
      return false;
    }
    if (!registration.registered) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "worktree-not-registered-in-expected-repository",
      });
      return false;
    }
    if (
      cleanupThread?.branch === null ||
      cleanupThread?.branch === undefined ||
      registration.branchName !== cleanupThread.branch
    ) {
      yield* worktreeCleanupJobs.markNeedsAttention({
        threadId,
        reason: "worktree-branch-mismatch",
      });
      return false;
    }
    return true;
  });

  const reserveCleanup = Effect.fn("reserveCleanup")(function* (threadId: ThreadId) {
    const cleanupOption = yield* worktreeCleanupJobs.getByThreadId(threadId);
    if (Option.isNone(cleanupOption) || cleanupOption.value.status !== "waiting") {
      return Option.none<{
        readonly cleanup: WorktreeCleanupJob;
        readonly canonicalPath: string;
        readonly siblingThreadIds: ReadonlyArray<ThreadId>;
      }>();
    }
    const cleanup = cleanupOption.value;
    const now = yield* cleanupNow();
    if (cleanup.nextAttemptAt !== null && cleanup.nextAttemptAt > now) {
      return Option.none();
    }
    const canonicalPath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(cleanup.worktreePath),
    );
    const readModel = yield* orchestrationEngine.getReadModel();
    const cleanupThread = readModel.threads.find((thread) => thread.id === threadId);
    if (
      cleanup.source === "archive" &&
      (cleanupThread === undefined || cleanupThread.archivedAt === null)
    ) {
      yield* worktreeCleanupJobs.cancelByThreadId(threadId);
      return Option.none();
    }
    if (cleanup.source === "delete" && cleanupThread?.deletedAt === null) {
      yield* worktreeCleanupJobs.cancelByThreadId(threadId);
      return Option.none();
    }

    const activeOwner = yield* findCanonicalActiveWorktreeOwner(readModel, threadId, canonicalPath);
    if (Option.isSome(activeOwner)) {
      yield* deferCleanup(threadId, "active-worktree-owner", undefined, cleanup.attemptCount);
      return Option.none();
    }

    // Reserve while holding the per-checkout lock, the same lock a turn start
    // holds while it checks for a pending cleanup. That makes "observe no
    // reservation" and "create the reservation" mutually exclusive.
    //
    // The global worktree lock is not sufficient on its own: turn starts no
    // longer take it, so without this a start could check for cleanup, find
    // none, and then have the worktree reserved and its provider stopped before
    // it ever dispatched. This is the reservation main's global lock was
    // covering for turn starts.
    const reservation = yield* checkoutCoordinator.withCheckout(
      canonicalPath,
      worktreeCleanupJobs.tryReserveForRemoval({
        threadId,
        canonicalWorktreePath: canonicalPath,
        reservedAt: now,
      }),
    );
    if (Option.isNone(reservation)) {
      return Option.none();
    }

    const siblingThreadIds = yield* Effect.forEach(
      readModel.threads.filter(
        (thread) =>
          thread.id !== threadId &&
          thread.worktreePath !== null &&
          (thread.archivedAt !== null || thread.deletedAt !== null),
      ),
      (thread) =>
        Effect.promise(() => canonicalizeWorktreePath(thread.worktreePath!)).pipe(
          Effect.map((path) => (path === canonicalPath ? thread.id : null)),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((ids) => ids.filter((id): id is ThreadId => id !== null)));

    return Option.some({
      cleanup: reservation.value.cleanup,
      canonicalPath,
      siblingThreadIds,
    });
  });

  const runReservedCleanup = ({
    cleanup,
    canonicalPath,
    siblingThreadIds,
  }: {
    readonly cleanup: WorktreeCleanupJob;
    readonly canonicalPath: string;
    readonly siblingThreadIds: ReadonlyArray<ThreadId>;
  }) =>
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

      const preflight = yield* orchestrationEngine.withWorktreeLock(
        Effect.gen(function* () {
          const readModel = yield* orchestrationEngine.getReadModel();
          const activeOwner = yield* findCanonicalActiveWorktreeOwner(
            readModel,
            cleanup.threadId,
            canonicalPath,
          );
          const cleanupThread = readModel.threads.find((thread) => thread.id === cleanup.threadId);
          if (cleanupThread === undefined) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: "thread-not-found",
            });
            return null;
          }
          if (
            Option.isSome(activeOwner) ||
            (cleanup.source === "archive" && cleanupThread.archivedAt === null)
          ) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: Option.isSome(activeOwner) ? "active-worktree-owner" : "owner-reopened",
            });
            return null;
          }
          return { branch: cleanupThread.branch };
        }),
      );
      if (preflight === null) {
        return;
      }

      const detachedPath = yield* checkoutCoordinator.withCheckout(
        cleanup.cwd,
        Effect.gen(function* () {
          const registeredWorktrees = yield* git.listRegisteredWorktrees(cleanup.cwd);
          if (!registeredWorktrees.isRepo) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: "repository-unavailable",
            });
            return null;
          }
          const canonicalWorktrees = yield* Effect.forEach(
            registeredWorktrees.worktrees,
            ({ branch, path }) =>
              Effect.promise(() => canonicalizeWorktreePath(path)).pipe(
                Effect.map((canonicalRegisteredPath) => ({
                  branch,
                  path: canonicalRegisteredPath,
                })),
              ),
            { concurrency: 4 },
          );
          const registeredWorktree = canonicalWorktrees.find(({ path }) => path === canonicalPath);
          const exists = yield* fileSystem.exists(canonicalPath);
          if (!exists) {
            // Nothing left on disk to lose (including a crash after detaching);
            // prune drops any stale registration.
            yield* git.pruneWorktrees(cleanup.cwd);
            yield* worktreeCleanupJobs.markCompleted({ threadId: cleanup.threadId });
            return null;
          }
          if (registeredWorktree === undefined) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: "worktree-registration-mismatch",
            });
            return null;
          }
          if (preflight.branch === null || registeredWorktree.branch !== preflight.branch) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: cleanup.threadId,
              reason: "worktree-branch-mismatch",
            });
            return null;
          }
          const isClean = yield* git.isWorktreeCleanForRemoval(canonicalPath);
          if (!isClean) {
            yield* deferCleanup(
              cleanup.threadId,
              "dirty-worktree",
              undefined,
              cleanup.attemptCount,
            );
            return null;
          }
          // Detach with an O(1) rename so the repository checkout lock is not held
          // while multi-gigabyte dependency trees are deleted. The branch ref is
          // untouched, so committed work stays reachable.
          const trashPath = path.join(
            worktreeTrashDirectory(canonicalPath),
            `${path.basename(canonicalPath)}-${crypto.randomUUID()}`,
          );
          yield* fileSystem.makeDirectory(path.dirname(trashPath), { recursive: true });
          yield* fileSystem.rename(canonicalPath, trashPath);
          yield* git.pruneWorktrees(cleanup.cwd);
          yield* worktreeCleanupJobs.markCompleted({ threadId: cleanup.threadId });
          yield* gitStatusBroadcaster
            .refreshStatus(cleanup.cwd)
            .pipe(Effect.ignoreCause({ log: true }));
          yield* Effect.logInfo("removed reconciled worktree", {
            threadId: cleanup.threadId,
            worktreePath: canonicalPath,
          });
          return trashPath;
        }),
      );
      if (detachedPath !== null) {
        yield* deleteDetachedWorktree(detachedPath);
      }
    });

  const processWorktreeCleanup = Effect.fn("processWorktreeCleanup")(function* (
    threadId: ThreadId,
  ) {
    if (!(yield* reconcileCleanupIntent(threadId))) {
      return;
    }
    yield* processAfterWorktreeReservation(
      orchestrationEngine.withWorktreeLock,
      reserveCleanup(threadId),
      (reservation) =>
        runAfterThreadRuntimeTeardown(
          stopActiveProviderSession(threadId),
          closeThreadTerminalsEffect(threadId),
          runReservedCleanup(reservation).pipe(
            Effect.flatMap(() => worktreeCleanupJobs.getByThreadId(threadId)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (job) =>
                  job.status === "completed" ? releaseThreadOwnership(threadId) : Effect.void,
              }),
            ),
          ),
        ),
    );
  });

  const recordWorktreeCleanupFailure = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
    cause: Cause.Cause<unknown>,
  ) =>
    Effect.gen(function* () {
      const job = yield* worktreeCleanupJobs.getByThreadId(threadId);
      const now = yield* cleanupNow();
      const nextAttemptAt = Option.isSome(job)
        ? yield* cleanupRetryAt(job.value.attemptCount)
        : now;
      return yield* worktreeCleanupJobs
        .recordFailure({
          threadId,
          error: Cause.pretty(cause),
          now,
          nextAttemptAt,
          maxAttempts: MAX_WORKTREE_CLEANUP_ATTEMPTS,
        })
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (result) =>
                result.status === "needs-attention"
                  ? Effect.logError(
                      "worktree cleanup requires manual review after repeated failures",
                      {
                        threadId,
                        attemptCount: result.attemptCount,
                        cause: Cause.pretty(cause),
                      },
                    )
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
    });

  const queuedWorktreeCleanups = new Set<ThreadDeletedEvent["payload"]["threadId"]>();
  const worktreeCleanupWorker = yield* makeDrainableWorker(
    (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
      processWorktreeCleanup(threadId).pipe(
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

  const enqueueArchiveCleanupIntent = Effect.fn("enqueueArchiveCleanupIntent")(function* (
    threadId: ThreadId,
    allowTerminalReset = false,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread === undefined || thread.worktreePath === null) {
      return;
    }
    const project = readModel.projects.find((entry) => entry.id === thread.projectId);
    if (project === undefined) {
      return;
    }

    const requestedAt = yield* cleanupNow();
    const canonicalWorktreePath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(thread.worktreePath!),
    );
    const job = yield* worktreeCleanupJobs
      .enqueue({
        threadId,
        cwd: project.workspaceRoot,
        worktreePath: thread.worktreePath,
        canonicalWorktreePath,
        requestedAt,
        source: "archive",
        allowTerminalReset,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logDebug("archive worktree cleanup intent not persisted", {
            threadId,
            worktreePath: canonicalWorktreePath,
            error: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.as(null)),
        ),
      );
    if (
      job === null ||
      job.status !== "waiting" ||
      (job.nextAttemptAt !== null && job.nextAttemptAt > requestedAt)
    ) {
      return;
    }
    yield* enqueueWorktreeCleanup(threadId);
    yield* Effect.logInfo("queued archive worktree cleanup reconciliation", {
      threadId,
      worktreePath: canonicalWorktreePath,
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

    // Archive cleanup removes clean checkouts but keeps their branch, so bring
    // the chat back on the same branch and path instead of losing its workspace.
    const project = thread
      ? readModel.projects.find((entry) => entry.id === thread.projectId)
      : undefined;
    if (thread?.branch && project !== undefined && project.deletedAt === null) {
      const restored = yield* checkoutCoordinator
        .withCheckout(
          project.workspaceRoot,
          git.pruneWorktrees(project.workspaceRoot).pipe(
            Effect.andThen(
              git.createWorktree({
                cwd: project.workspaceRoot,
                branch: thread.branch,
                path: worktreePath,
              }),
            ),
          ),
        )
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("failed to restore archived worktree on unarchive", {
              threadId,
              worktreePath: canonicalPath,
              error: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
      if (restored) {
        yield* projectSetupScriptRunner
          .runForThread({
            threadId,
            projectId: project.id,
            projectCwd: project.workspaceRoot,
            worktreePath,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("setup script failed after restoring worktree", {
                threadId,
                error: error.message,
              }),
            ),
          );
        return;
      }
    }

    // Clear the orchestration read model via a domain event so later bindings
    // don't treat a missing path as still owned by this thread.
    yield* orchestrationEngine
      .dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(crypto.randomUUID()),
        threadId,
        worktreePath: null,
        workspaceBinding: null,
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
    if (event.type === "thread.deleted") {
      yield* runAfterThreadRuntimeTeardown(
        stopActiveProviderSession(threadId),
        closeThreadTerminalsEffect(threadId),
        releaseThreadOwnership(threadId),
      );
    } else {
      yield* Effect.all([stopProviderSession(threadId), closeThreadTerminals(threadId)], {
        concurrency: "unbounded",
        discard: true,
      });
    }

    if (event.type === "thread.archived") {
      yield* enqueueArchiveCleanupIntent(threadId, true);
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

  const recoverInterruptedRemovals = Effect.gen(function* () {
    const now = yield* cleanupNow();
    const jobs = yield* worktreeCleanupJobs.list();
    yield* Effect.forEach(
      jobs.filter((job) => job.status === "removing" && !queuedWorktreeCleanups.has(job.threadId)),
      (job) =>
        Effect.gen(function* () {
          const exists = yield* fileSystem.exists(job.canonicalWorktreePath);
          const registration = yield* inspectRegisteredWorktree(job);
          if (!registration.isRepo) {
            yield* worktreeCleanupJobs.markNeedsAttention({
              threadId: job.threadId,
              reason: "repository-unavailable-during-recovery",
            });
            return;
          }
          if (!exists && !registration.registered) {
            yield* checkoutCoordinator.withCheckout(job.cwd, git.pruneWorktrees(job.cwd));
            yield* worktreeCleanupJobs.markCompleted({ threadId: job.threadId });
            return;
          }
          yield* worktreeCleanupJobs.recoverRemoving({
            threadId: job.threadId,
            nextAttemptAt: now,
            reason: "recovered-after-restart",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const nextAttemptAt = yield* cleanupRetryAt(job.attemptCount);
              yield* worktreeCleanupJobs
                .recoverRemoving({
                  threadId: job.threadId,
                  nextAttemptAt,
                  reason: "recovery-check-failed",
                })
                .pipe(
                  Effect.catchCause((recoveryCause) =>
                    Effect.logError("failed to persist worktree removal recovery", {
                      threadId: job.threadId,
                      cause: Cause.pretty(recoveryCause),
                    }),
                  ),
                );
              yield* Effect.logWarning(
                "worktree removal recovery deferred after transient failure",
                {
                  threadId: job.threadId,
                  cause: Cause.pretty(cause),
                },
              );
            }),
          ),
        ),
      { concurrency: 2, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("failed to enumerate interrupted worktree removals", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const enqueueDueWorktreeCleanups = Effect.fn("enqueueDueWorktreeCleanups")(
    function* () {
      const jobs = yield* worktreeCleanupJobs.listDue({ now: yield* cleanupNow() });
      yield* Effect.forEach(jobs, (job) => enqueueWorktreeCleanup(job.threadId), {
        concurrency: 1,
        discard: true,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("worktree cleanup due sweep failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const discoverArchivedCleanupCandidates = Effect.fn("discoverArchivedCleanupCandidates")(
    function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const candidates = readModel.threads.filter(
        (thread) => thread.archivedAt !== null && thread.deletedAt === null,
      );
      yield* Effect.forEach(candidates, (thread) => enqueueArchiveCleanupIntent(thread.id), {
        concurrency: 4,
        discard: true,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("archived worktree cleanup discovery failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  // Associations are written when a PR is opened/linked and otherwise only
  // refreshed on archive cleanup. Without a background pass, sidebar chrome
  // keeps the original "open" colour after merge/close.
  const refreshOpenPullRequestAssociations = Effect.fn("refreshOpenPullRequestAssociations")(
    function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const groups = groupOpenPullRequestAssociationRefreshes(readModel);

      yield* Effect.forEach(
        groups,
        (group) =>
          Effect.gen(function* () {
            const resolved = yield* resolvePullRequestFromCwds(
              group.cwds,
              group.pullRequest.url,
              gitManager.resolvePullRequest,
            );
            if (resolved === null) {
              yield* Effect.logDebug("pull request association refresh skipped", {
                threadId: group.candidates[0]?.thread.id,
                pullRequestNumber: group.pullRequest.number,
                attemptedCwds: group.cwds,
              });
              return;
            }
            const nextPullRequest = resolved.pullRequest;
            yield* Effect.forEach(
              group.candidates.filter(
                ({ link: candidateLink }) =>
                  candidateLink.pullRequest.state !== nextPullRequest.state ||
                  candidateLink.pullRequest.title !== nextPullRequest.title ||
                  candidateLink.pullRequest.url !== nextPullRequest.url ||
                  candidateLink.pullRequest.baseBranch !== nextPullRequest.baseBranch ||
                  candidateLink.pullRequest.headBranch !== nextPullRequest.headBranch,
              ),
              ({ thread: candidateThread, link: candidateLink }) =>
                (threadPullRequestKey(candidateLink.pullRequest) ===
                threadPullRequestKey(nextPullRequest)
                  ? orchestrationEngine
                      .dispatch({
                        type: "thread.pull-request.link",
                        commandId: CommandId.make(crypto.randomUUID()),
                        threadId: candidateThread.id,
                        pullRequest: nextPullRequest,
                        source: candidateLink.source,
                      })
                      .pipe(
                        Effect.andThen(
                          candidateThread.pullRequest &&
                            sameThreadPullRequest(
                              candidateThread.pullRequest,
                              candidateLink.pullRequest,
                            )
                            ? orchestrationEngine.dispatch({
                                type: "thread.meta.update",
                                commandId: CommandId.make(crypto.randomUUID()),
                                threadId: candidateThread.id,
                                pullRequest: nextPullRequest,
                              })
                            : Effect.void,
                        ),
                      )
                  : orchestrationEngine.dispatch({
                      type: "thread.pull-request.rekey",
                      commandId: CommandId.make(crypto.randomUUID()),
                      threadId: candidateThread.id,
                      previousPullRequest: candidateLink.pullRequest,
                      pullRequest: nextPullRequest,
                    })
                ).pipe(
                  Effect.catch((error) =>
                    Effect.logDebug("failed to persist refreshed pull request association", {
                      threadId: candidateThread.id,
                      pullRequestNumber: candidateLink.pullRequest.number,
                      error: error instanceof Error ? error.message : String(error),
                    }),
                  ),
                ),
              { concurrency: 2, discard: true },
            );
          }),
        { concurrency: 2, discard: true },
      );
    },
  );

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* recoverInterruptedRemovals;
    yield* Effect.forkScoped(sweepWorktreeTrash);
    yield* discoverArchivedCleanupCandidates();
    yield* enqueueDueWorktreeCleanups();
    yield* Effect.forkScoped(
      enqueueDueWorktreeCleanups().pipe(Effect.repeat(Schedule.spaced(CLEANUP_DUE_SWEEP_INTERVAL))),
    );
    yield* Effect.forkScoped(
      discoverArchivedCleanupCandidates().pipe(
        Effect.repeat(Schedule.spaced(CLEANUP_RECONCILIATION_INTERVAL)),
      ),
    );
    yield* Effect.forkScoped(
      refreshOpenPullRequestAssociations().pipe(
        // First pass soon after boot so sidebar colours catch up without waiting
        // for archive; then keep associations warm without hammering gh.
        Effect.repeat(Schedule.spaced("5 minutes")),
      ),
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
              checkoutCoordinator.withCheckout(cwd, git.pruneWorktrees(cwd)).pipe(
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
  Layer.provideMerge(CheckoutCoordinatorLive),
);
