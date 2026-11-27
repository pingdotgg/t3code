import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  didRunReachProvider,
  isRetiredProviderThread,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
  repositoryRewindCheckpoint,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ServerConfig from "../config.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import {
  withCheckpointRestoreReservation,
  withWorkspaceLease,
} from "../workspace/workspaceLease.ts";
import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointRestoreError, CheckpointServiceV2 } from "./CheckpointService.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { GIT_INDEX_LOCKED_DETAIL } from "../vcs/VcsProcess.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyAboveCeilingError, RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

const ROLLBACK_BACKGROUND_WORK_MESSAGE =
  "A session being rewound is still running background agents or commands. Wait for them to finish, or press Stop, then rewind again.";

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "shared-workspace",
      "background-work-active",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "shared-workspace":
        return SHARED_WORKSPACE_RESTORE_MESSAGE;
      case "background-work-active":
        return ROLLBACK_BACKGROUND_WORK_MESSAGE;
      case "unexpected-failure":
        return ROLLBACK_FAILED_MESSAGE;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);
const isVcsProcessExitError = Schema.is(VcsProcessExitError);
const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);
const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

/**
 * The message clients see when a rollback fails. Only a held Git index lock
 * or active background work gets its own explanation; other reasons carry
 * internal ids or raw Git output, so they fall back to the generic message.
 */
export function rollbackFailureClientMessage(error: CheckpointRollbackExecutionError): string {
  if (error.reason === "background-work-active") return ROLLBACK_BACKGROUND_WORK_MESSAGE;
  if (isRuntimePolicyAboveCeilingError(error.cause)) return error.cause.message;
  const restoreCause = isCheckpointRestoreError(error.cause) ? error.cause.cause : undefined;
  return isVcsProcessExitError(restoreCause) && restoreCause.detail === GIT_INDEX_LOCKED_DETAIL
    ? GIT_INDEX_LOCKED_DETAIL
    : ROLLBACK_FAILED_MESSAGE;
}

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
    /** The rewind command: names the request when repositories are reported as left unrestored. */
    readonly requestId?: CommandId;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | GitWorkflowService.GitWorkflowService
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
  | Path.Path
  | ProjectStore.ProjectStoreV2
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | TaskFolders.TaskFolders
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const taskFolders = yield* TaskFolders.TaskFolders;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
      readonly requestId?: CommandId;
    }) {
      const context = yield* projections.getCheckpointRollbackContext(input.threadId, input);
      if (context.thread.deletedAt !== null) return;
      const { providerThread, checkpoint, scope, targetAttempt, runsToRollback, staleCheckpoints } =
        context;
      const restoreFiles = input.restoreFiles !== false;
      const { worktreePath, branch } = context.thread;
      const taskFolder = worktreePath === null ? null : yield* taskFolders.find(worktreePath);
      // A linked project folder is not a repository: it has no snapshot, by design.
      const linkedProjectFolder = taskFolder !== null && !taskFolder.projectIsWorktree;
      const invalidTarget = () =>
        new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        isRetiredProviderThread(providerThread) ||
        checkpoint === undefined ||
        scope === undefined ||
        // A repository's checkpoints follow the thread's; they are not a place to rewind to.
        typeof scope.repositoryPath === "string" ||
        checkpoint.scopeId !== scope.id ||
        // Missing or failed snapshots support conversation rewind; missing ones also restoring a
        // task folder's repositories.
        (checkpoint.status !== "ready" &&
          !(checkpoint.status === "error" && !restoreFiles) &&
          !(checkpoint.status === "missing" && (!restoreFiles || linkedProjectFolder)))
      ) {
        return yield* invalidTarget();
      }

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      if (targetOrdinal === 0 && providerThread.id !== context.thread.activeProviderThreadId) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      const rollbackTarget: ProviderAdapter.ProviderAdapterV2RollbackTarget =
        targetOrdinal === 0
          ? {
              type: "thread_start",
              checkpointId: checkpoint.id,
              appRunOrdinal: 0,
            }
          : yield* Effect.gen(function* () {
              const targetTurn =
                latestProviderTurnForAttempt(context.providerTurns, targetAttempt?.id) ??
                context.providerTurns.find((turn) => turn.id === targetAttempt?.providerTurnId);
              if (
                targetAttempt === undefined ||
                targetTurn === undefined ||
                targetTurn.providerThreadId !== providerThread.id
              ) {
                return yield* new CheckpointRollbackExecutionError({
                  reason: "provider-turn-unavailable",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              const { attempt } = yield* projections.getProviderControlContext(input.threadId, {
                providerThreadId: providerThread.id,
                providerTurnId: targetTurn.id,
                attemptId: targetAttempt.id,
              });
              const message =
                attempt === undefined
                  ? undefined
                  : yield* projections.getRunMessage(input.threadId, attempt.runId);
              return {
                type: "provider_turn" as const,
                checkpointId: checkpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
                ...(message === undefined ? {} : { message }),
              };
            });

      const isolated = isCheckpointRestoreIsolated(context.thread, scope, taskFolder, {
        fileSystem,
        projections,
        projects,
        path,
      });
      const sharedWorkspace = () =>
        new CheckpointRollbackExecutionError({
          reason: "shared-workspace",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });

      if (taskFolder !== null && branch != null) {
        // Cleanup can remove any of the folder's checkouts; the linked project folder has none.
        yield* taskFolders.restore({
          taskFolder,
          branch,
          projectCommands: TaskFolders.projectCommandsForLink(context.thread.linkOrigin),
          recreate: (checkout) =>
            gitWorkflow.pruneWorktrees({ cwd: checkout.repositoryPath }).pipe(
              Effect.andThen(
                gitWorkflow.createWorktree({
                  cwd: checkout.repositoryPath,
                  refName: branch,
                  path: checkout.worktreePath,
                }),
              ),
            ),
        });
      } else if (worktreePath != null && branch != null) {
        // Recreated only where the server would have made it, as turn start does.
        // A failed removal can leave the folder without its checkout; only a file restore replaces it.
        const leftover =
          restoreFiles &&
          (yield* fileSystem.exists(worktreePath)) &&
          !(yield* fileSystem.exists(path.join(worktreePath, ".git")));
        if (
          (leftover || !(yield* fileSystem.exists(worktreePath))) &&
          (yield* isManagedWorktreePath(worktreePath))
        ) {
          const project = yield* projects.get(context.thread.projectId);
          if (Option.isSome(project)) {
            const recreate = gitWorkflow.pruneWorktrees({ cwd: project.value.workspaceRoot }).pipe(
              Effect.andThen(
                gitWorkflow.createWorktree({
                  cwd: project.value.workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                }),
              ),
            );
            if (leftover) {
              if (!(yield* isolated)) return yield* sharedWorkspace();
              // Set aside, not removed: a checkout that fails puts the folder and its files back.
              yield* Effect.acquireUseRelease(
                Effect.gen(function* () {
                  const aside = yield* fileSystem.makeTempDirectory({
                    directory: path.dirname(worktreePath),
                    prefix: ".t3-replaced-",
                  });
                  yield* fileSystem.rename(worktreePath, path.join(aside, "folder"));
                  return aside;
                }),
                () => recreate,
                (aside, exit) =>
                  (Exit.isSuccess(exit)
                    ? Effect.void
                    : fileSystem
                        .remove(worktreePath, { recursive: true, force: true })
                        .pipe(
                          Effect.andThen(
                            fileSystem.rename(path.join(aside, "folder"), worktreePath),
                          ),
                        )
                  ).pipe(
                    Effect.andThen(fileSystem.remove(aside, { recursive: true, force: true })),
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Edit from here left a worktree folder set aside", {
                        worktreePath,
                        setAside: path.join(aside, "folder"),
                        cause,
                      }),
                    ),
                  ),
              );
            } else {
              yield* recreate;
            }
          }
        }
      }

      if (restoreFiles && !(yield* isolated)) return yield* sharedWorkspace();

      // Before the provider conversation changes: a rewind with nothing to restore is refused.
      const readable =
        restoreFiles && taskFolder !== null
          ? yield* checkpoints.repositoryScopesIfReadable({
              rootScope: scope,
              projectId: context.thread.projectId,
              worktreePath,
            })
          : [];
      // Unknown repositories are not "none": the rewind would leave their changes unmentioned.
      if (readable === null) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "unexpected-failure",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          cause: new Error("The thread's repositories could not be read."),
        });
      }
      const repositories = readable;
      const recorded =
        repositories.length === 0
          ? []
          : (yield* projections.getCheckpointContext(input.threadId)).checkpoints;
      const repositoryTargets = repositories.flatMap((repository) => {
        const target = repositoryRewindCheckpoint(
          recorded.filter((candidate) => candidate.scopeId === repository.id),
          targetOrdinal,
        );
        return target === null ? [] : [{ scope: repository, checkpoint: target }];
      });
      // Changed by a discarded run, with no snapshot of how it was before: left as it is.
      const unrestorable = repositories.filter(
        (repository) =>
          !repositoryTargets.some((target) => target.scope.id === repository.id) &&
          recorded.some(
            (candidate) =>
              candidate.scopeId === repository.id &&
              candidate.ordinalWithinScope > targetOrdinal &&
              (candidate.status === "ready" || candidate.runId !== null),
          ),
      );
      if (unrestorable.length > 0) {
        yield* Effect.logWarning("Edit from here cannot restore repositories without a snapshot", {
          threadId: input.threadId,
          repositories: unrestorable.map((repository) => repository.cwd),
        });
      }
      const restoreTargets = [
        ...(checkpoint.status === "ready" ? [{ scope, checkpoint }] : []),
        ...repositoryTargets,
      ];
      if (restoreFiles && restoreTargets.length === 0) return yield* invalidTarget();

      const {
        abandonedProviderThreads,
        spanningProviderThreads,
        backgroundCheckSessions,
        abandonedSessions,
      } = context;
      const backgroundCheckProviderThreads = [
        ...abandonedProviderThreads,
        ...spanningProviderThreads
          .filter((entry) => entry.needsRollback)
          .map((entry) => entry.providerThread),
      ];
      const backgroundWorkActive = () =>
        new CheckpointRollbackExecutionError({
          reason: "background-work-active",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      if (
        backgroundCheckProviderThreads.some(
          (candidate) => (candidate.pendingBackgroundTasks?.length ?? 0) > 0,
        )
      ) {
        return yield* backgroundWorkActive();
      }
      if (backgroundCheckProviderThreads.length > 0 && backgroundCheckSessions.length > 0) {
        const abandonedSessionIds = new Set(abandonedSessions.map((session) => session.id));
        const spanningRollbackSessionIds = new Set(
          spanningProviderThreads.flatMap((entry) =>
            entry.needsRollback && entry.providerThread.providerSessionId !== null
              ? [entry.providerThread.providerSessionId]
              : [],
          ),
        );
        for (const checkSession of backgroundCheckSessions) {
          const isMultiThread =
            checkSession.capabilities.sessions.supportsMultipleProviderThreadsPerSession;
          if (
            !isMultiThread &&
            !abandonedSessionIds.has(checkSession.id) &&
            !spanningRollbackSessionIds.has(checkSession.id)
          ) {
            continue;
          }
          const runtimeOption = yield* sessions
            .get(checkSession.id)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(runtimeOption)) continue;
          const runtime = runtimeOption.value;
          const probes =
            !isMultiThread && runtime.hasPendingBackgroundWork !== undefined
              ? [runtime.hasPendingBackgroundWork]
              : backgroundCheckProviderThreads.flatMap((candidate) =>
                  candidate.providerSessionId === checkSession.id &&
                  runtime.hasPendingBackgroundWorkForThread !== undefined
                    ? [runtime.hasPendingBackgroundWorkForThread(candidate)]
                    : [],
                );
          for (const probe of probes) {
            if (yield* probe.pipe(Effect.catchCause(() => Effect.succeed(true)))) {
              return yield* backgroundWorkActive();
            }
          }
        }
      }

      const rolledBackAttemptIds = new Set(context.rolledBackAttemptIds);
      const targetConversationThreadIds = new Set(context.targetConversationThreadIds);
      const targetRunsToRollback = runsToRollback.filter(
        (run) =>
          didRunReachProvider(run, context.providerTurns) &&
          run.providerThreadId !== null &&
          targetConversationThreadIds.has(run.providerThreadId),
      );
      // Cross-provider boundary rewind: every discarded delivered run belonged to other native
      // conversations, so the target provider conversation already stands at `targetOrdinal`.
      const isCrossProviderBoundaryRewind =
        runsToRollback.length > 0 && targetRunsToRollback.length === 0;
      // Mutate the target provider first so a target refusal never truncates a spanning
      // conversation; any spanning rollback that fails afterward falls back to retiring that thread.
      const snapshot = isCrossProviderBoundaryRewind
        ? { providerThread }
        : yield* Effect.gen(function* () {
            const modelSelection =
              providerThread.providerInstanceId === context.thread.modelSelection.instanceId
                ? context.thread.modelSelection
                : (context.targetRun?.modelSelection ??
                  targetRunsToRollback.at(-1)?.modelSelection ??
                  context.thread.modelSelection);
            const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
              thread: context.thread,
              modelSelection,
            });
            const existingSession = context.providerSession;
            const session = yield* sessions.open({
              threadId: input.threadId,
              providerSessionId: providerThread.providerSessionId!,
              modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
              ...(providerThread.nativeThreadRef?.nativeId == null
                ? {}
                : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
              ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
                ? {}
                : {
                    initialProviderItemIdentityVersion:
                      providerThread.nativeMetadata.itemIdentityVersion,
                  }),
            });

            if (targetRunsToRollback.length === 0) {
              return { providerThread };
            }

            // Rolled-back turns remain in audit history but no longer exist in the provider conversation.
            const providerThreadTurns = context.providerTurns.filter(
              (turn) =>
                targetConversationThreadIds.has(turn.providerThreadId) &&
                (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
            );

            return yield* session.rollbackThread({
              providerThread,
              target: rollbackTarget,
              providerThreadTurns,
            });
          });

      const failedSpanningConversationIds = new Set<ProviderThreadId>();
      const succeededSpanningById = new Map<
        ProviderThreadId,
        {
          readonly providerThread: OrchestrationV2ProviderThread;
          readonly lastRunOrdinal: number;
        }
      >();
      for (const spanning of spanningProviderThreads) {
        if (!spanning.needsRollback) continue;
        const spanningOutcome = yield* Effect.gen(function* () {
          const spanningAttempt = spanning.targetAttempt;
          const spanningTurn =
            latestProviderTurnForAttempt(context.providerTurns, spanningAttempt?.id) ??
            context.providerTurns.find((turn) => turn.id === spanningAttempt?.providerTurnId);
          if (
            spanning.providerThread.providerSessionId === null ||
            spanning.targetCheckpointId === null ||
            spanningAttempt === undefined ||
            spanningTurn === undefined ||
            spanningTurn.providerThreadId !== spanning.providerThread.id
          ) {
            return yield* new CheckpointRollbackExecutionError({
              reason: "provider-turn-unavailable",
              threadId: input.threadId,
              providerThreadId: spanning.providerThread.id,
              checkpointId: spanning.targetCheckpointId ?? input.checkpointId,
            });
          }
          const { attempt } = yield* projections.getProviderControlContext(input.threadId, {
            providerThreadId: spanning.providerThread.id,
            providerTurnId: spanningTurn.id,
            attemptId: spanningAttempt.id,
          });
          const message =
            attempt === undefined
              ? undefined
              : yield* projections.getRunMessage(input.threadId, attempt.runId);
          const spanningModelSelection =
            spanning.providerThread.providerInstanceId === context.thread.modelSelection.instanceId
              ? context.thread.modelSelection
              : spanning.targetRun.modelSelection;
          const spanningRuntimePolicy = yield* runtimePolicy.resolve({
            thread: context.thread,
            modelSelection: spanningModelSelection,
          });
          const spanningSession = yield* sessions.open({
            threadId: input.threadId,
            providerSessionId: spanning.providerThread.providerSessionId,
            modelSelection: spanningModelSelection,
            runtimePolicy: spanningRuntimePolicy,
            ...(spanning.providerSession === undefined
              ? {}
              : { resumeFromSession: spanning.providerSession }),
            ...(spanning.providerThread.nativeThreadRef?.nativeId == null
              ? {}
              : { initialNativeThreadId: spanning.providerThread.nativeThreadRef.nativeId }),
            ...(spanning.providerThread.nativeMetadata?.itemIdentityVersion === undefined
              ? {}
              : {
                  initialProviderItemIdentityVersion:
                    spanning.providerThread.nativeMetadata.itemIdentityVersion,
                }),
          });
          const spanningConversationIds = new Set(spanning.conversationThreadIds);
          const spanningTurns = context.providerTurns.filter(
            (turn) =>
              spanningConversationIds.has(turn.providerThreadId) &&
              (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
          );
          const spanningResult = yield* spanningSession.rollbackThread({
            providerThread: spanning.providerThread,
            target: {
              type: "provider_turn",
              checkpointId: spanning.targetCheckpointId,
              appRunOrdinal: spanning.targetRun.ordinal,
              providerTurn: spanningTurn,
              ...(message === undefined ? {} : { message }),
            },
            providerThreadTurns: spanningTurns,
          });
          return {
            providerThread: spanningResult.providerThread,
            lastRunOrdinal: spanning.targetRun.ordinal,
          };
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Spanning provider thread rollback failed; retiring conversation instead.",
              {
                threadId: input.threadId,
                providerThreadId: spanning.providerThread.id,
                cause,
              },
            ).pipe(Effect.as(undefined)),
          ),
        );
        if (spanningOutcome === undefined) {
          for (const threadIdInConv of spanning.conversationThreadIds) {
            failedSpanningConversationIds.add(threadIdInConv);
          }
        } else {
          succeededSpanningById.set(spanning.providerThread.id, spanningOutcome);
        }
      }
      const spanningSnapshots: Array<{
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly lastRunOrdinal: number;
      }> = [];
      const effectiveAbandonedProviderThreads: Array<OrchestrationV2ProviderThread> = [
        ...abandonedProviderThreads,
      ];
      for (const spanning of spanningProviderThreads) {
        if (failedSpanningConversationIds.has(spanning.providerThread.id)) {
          effectiveAbandonedProviderThreads.push(spanning.providerThread);
          continue;
        }
        const rolledBack = succeededSpanningById.get(spanning.providerThread.id);
        spanningSnapshots.push(
          rolledBack ?? {
            providerThread: spanning.providerThread,
            lastRunOrdinal: spanning.targetRun.ordinal,
          },
        );
      }
      if (restoreFiles) {
        yield* checkpoints.restore({ targets: restoreTargets, scopes: [scope, ...repositories] });
      }
      const staleScopeCheckpoints = staleCheckpoints.filter((stale) => stale.scopeId === scope.id);
      if (staleScopeCheckpoints.length > 0) {
        yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleScopeCheckpoints });
      }
      yield* checkpoints.discardRepositorySnapshots({
        rootScope: scope,
        thread: context.thread,
        ordinals: runsToRollback.map((run) => run.ordinal),
      });

      // Lock against full-row thread writes that could restore the old native session after rollback.
      yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
            Effect.map(
              ids.allocate.event({ threadId: event.threadId }),
              (id) =>
                ({
                  ...event,
                  id,
                }) as Event,
            );
          const events: Array<OrchestrationV2DomainEvent> = [];
          // First, so a client that sees the runs rolled back already knows the outcome.
          if (input.requestId !== undefined) {
            const thread = yield* projections.getThread(input.threadId);
            events.push(
              yield* makeEvent({
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...thread,
                  rollbackCompletedRequestId: input.requestId,
                  ...(unrestorable.length === 0
                    ? {}
                    : {
                        rollbackUnrestored: {
                          requestId: input.requestId,
                          repositories: unrestorable.map(
                            (repository) => repository.label ?? path.basename(repository.cwd),
                          ),
                        },
                      }),
                  updatedAt: now,
                },
              }),
            );
          }
          for (const spanning of spanningSnapshots) {
            events.push(
              yield* makeEvent({
                type: "provider-thread.updated",
                threadId: input.threadId,
                driver: spanning.providerThread.driver,
                providerInstanceId: spanning.providerThread.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...spanning.providerThread,
                  lastRunOrdinal: spanning.lastRunOrdinal,
                  updatedAt: now,
                },
              }),
            );
          }
          for (const abandoned of effectiveAbandonedProviderThreads) {
            events.push(
              yield* makeEvent({
                type: "provider-thread.updated",
                threadId: input.threadId,
                driver: abandoned.driver,
                providerInstanceId: abandoned.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...abandoned,
                  status: "closed",
                  lastRunOrdinal: null,
                  updatedAt: now,
                },
              }),
            );
          }
          events.push(
            yield* makeEvent({
              type: "provider-thread.updated",
              threadId: input.threadId,
              driver: providerThread.driver,
              providerInstanceId: providerThread.providerInstanceId,
              occurredAt: now,
              payload: {
                ...snapshot.providerThread,
                lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
                updatedAt: now,
              },
            }),
          );
          const detachEffects: Array<PendingOrchestrationEffectV2> = [];
          const detachCommandId =
            input.requestId ??
            CommandId.make(`command:rollback-detach:${input.threadId}:${input.checkpointId}`);
          for (const abandonedSession of context.abandonedSessions) {
            events.push(
              yield* makeEvent({
                type: "provider-session.detached",
                threadId: input.threadId,
                driver: abandonedSession.driver,
                providerInstanceId: abandonedSession.providerInstanceId,
                occurredAt: now,
                payload: {
                  providerSessionId: abandonedSession.id,
                  detachedAt: now,
                  reason: "Rewound past this provider session.",
                },
              }),
            );
            detachEffects.push({
              id: `effect:${detachCommandId}:provider-session.detach:${abandonedSession.id}`,
              commandId: detachCommandId,
              threadId: input.threadId,
              request: {
                type: "provider-session.detach",
                providerSessionId: abandonedSession.id,
                detail: "Rewound past this provider session.",
              },
            });
          }
          for (const staleCheckpoint of staleCheckpoints) {
            events.push(
              yield* makeEvent({
                type: "checkpoint.captured",
                threadId: input.threadId,
                ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
                nodeId: staleCheckpoint.nodeId,
                providerInstanceId: providerThread.providerInstanceId,
                occurredAt: now,
                payload: { ...staleCheckpoint, status: "stale" },
              }),
            );
          }
          for (const run of runsToRollback) {
            const rootNode = context.rootNodes.find((candidate) => candidate.id === run.rootNodeId);
            events.push(
              yield* makeEvent({
                type: "run.updated",
                threadId: input.threadId,
                runId: run.id,
                ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...run, status: "rolled_back", completedAt: now },
              }),
            );
            if (rootNode !== undefined) {
              events.push(
                yield* makeEvent({
                  type: "node.updated",
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: rootNode.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: { ...rootNode, status: "rolled_back", completedAt: now },
                }),
              );
            }
          }
          if (detachEffects.length > 0) {
            yield* eventSink.writeWithEffects({ events, effects: detachEffects });
          } else {
            yield* eventSink.write({ events });
          }
        }),
      );
    });

    return CheckpointRollbackServiceV2.of({
      // The inner execute owns the rollback span; this wrapper selects the workspace lease.
      execute: Effect.fnUntraced(
        function* (input) {
          // Storage cleanup removes worktrees under the same lease.
          const thread = yield* projections.getThread(input.threadId);
          if (thread.worktreePath === null) return yield* execute(input);
          const worktreePath = path.resolve(thread.worktreePath);
          const rollback = withWorkspaceLease(worktreePath, execute(input));
          // Shared-workspace restores are rejected and conversation-only rewinds
          // touch no files; reserving for them would stall turn starts on the
          // slow provider rollback for nothing.
          yield* input.restoreFiles === false
            ? rollback
            : withCheckpointRestoreReservation(fileSystem, path, worktreePath, rollback);
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isCheckpointRollbackExecutionError(cause)
                ? cause
                : new CheckpointRollbackExecutionError({
                    reason: "unexpected-failure",
                    threadId: input.threadId,
                    providerThreadId: input.providerThreadId,
                    checkpointId: input.checkpointId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
