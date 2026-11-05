import {
  CheckpointId,
  CheckpointScopeId,
  type CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { withRepositoryLeases, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  participatingRepositories,
  planCheckpointRestore,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
  sharedRepositoryRestoreMessage,
} from "./CheckpointRestoreSafety.ts";
import {
  CheckpointRepositoryUnavailableError,
  type CheckpointRepositoryIdentity,
  CheckpointServiceV2,
} from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "shared-workspace",
      "shared-repository",
      "repository-unavailable",
      "workspace-restore-failed",
      "repository-restore-failed",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    /** The repository worktree a repository reason is about. */
    repository: Schema.optional(Schema.String),
    worktreePath: Schema.optional(Schema.String),
    repositoryProblem: Schema.optional(CheckpointRepositoryUnavailableError.fields.reason),
    submodulePath: Schema.optional(Schema.String),
    /** Repositories whose files were already restored when a later one failed. */
    restoredRepositories: Schema.optional(Schema.Array(Schema.String)),
    /** A restore failure after the conversation already went back to the target. */
    conversationRewound: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const repository = { repository: this.repository ?? "", worktreePath: this.worktreePath ?? "" };
    const restoreStopped = (stoppedAt: string) =>
      this.conversationRewound === true
        ? `The conversation was rewound, but restoring files stopped at ${stoppedAt}.`
        : `Restoring files stopped at ${stoppedAt}.`;
    const tryAgain =
      this.conversationRewound === true
        ? "then try again to finish restoring files."
        : "then roll back again.";
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "shared-workspace":
        return SHARED_WORKSPACE_RESTORE_MESSAGE;
      case "shared-repository":
        return sharedRepositoryRestoreMessage(repository);
      case "repository-unavailable":
        return `${
          new CheckpointRepositoryUnavailableError({
            ...repository,
            reason: this.repositoryProblem ?? "checkpoint-missing",
            ...(this.submodulePath === undefined ? {} : { submodulePath: this.submodulePath }),
          }).message
        } Nothing was changed. Rewind the conversation without restoring files instead.`;
      case "workspace-restore-failed":
        return `${restoreStopped(`the thread's worktree at ${repository.worktreePath}`)} Check that worktree, ${tryAgain}`;
      case "repository-restore-failed":
        return `${restoreStopped(
          `the ${repository.repository} worktree at ${repository.worktreePath}`,
        )} ${
          (this.restoredRepositories ?? []).length === 0
            ? "No repository worktree was restored."
            : `Already restored: ${(this.restoredRepositories ?? []).join(", ")}.`
        } Check that worktree, ${tryAgain}`;
      case "unexpected-failure":
        return ROLLBACK_FAILED_MESSAGE;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);

const FILE_RESTORE_REFUSALS: ReadonlySet<CheckpointRollbackExecutionError["reason"]> = new Set([
  "shared-workspace",
  "shared-repository",
  "repository-unavailable",
  "workspace-restore-failed",
  "repository-restore-failed",
]);

/** A rollback stopped over the files it would restore, with a message for the user. */
export const isFileRestoreRefusal = (error: CheckpointRollbackExecutionError) =>
  FILE_RESTORE_REFUSALS.has(error.reason);

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
    /** The rollback command, so a failure after the conversation rewound is recorded with it. */
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
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

    const prepareRepositoryRestore = (input: {
      readonly repository: CheckpointRepositoryIdentity;
      readonly history: Parameters<
        CheckpointServiceV2["Service"]["resolveRepositorySnapshot"]
      >[0]["history"];
      readonly targetOrdinal: number;
    }) =>
      Effect.gen(function* () {
        const snapshot = yield* checkpoints.resolveRepositorySnapshot(input);
        if (snapshot._tag !== "found") {
          return yield* new CheckpointRepositoryUnavailableError({
            repository: input.repository.repository,
            worktreePath: input.repository.worktreePath,
            reason: "checkpoint-missing",
          });
        }
        const { recreate } = yield* checkpoints.inspectRepositoryRestore({
          repository: input.repository,
          ref: snapshot.ref,
        });
        return { repository: input.repository, ref: snapshot.ref, recreate };
      });

    // Attaching and removing a repository's worktrees take its lease, so the
    // checks hold until the files are restored.
    const repositoryLeaseKeys = (input: {
      readonly threadId: ThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
    }) =>
      Effect.gen(function* () {
        if (input.restoreFiles === false) return [];
        const projection = yield* projections.getThreadRecords(input.threadId, [
          "checkpoints",
          "checkpointScopes",
        ]);
        const checkpoint = projection.checkpoints.find(
          (candidate) => candidate.id === input.checkpointId,
        );
        const scope = projection.checkpointScopes.find(
          (candidate) => candidate.id === input.scopeId,
        );
        if (checkpoint === undefined || scope === undefined) return [];
        const keys = yield* Effect.forEach(
          participatingRepositories({
            thread: projection.thread,
            scope,
            checkpoints: projection.checkpoints,
            targetOrdinal: checkpoint.ordinalWithinScope,
          }),
          (repository) => checkpoints.repositoryLeaseKey(repository),
        );
        return keys.filter((key): key is string => key !== null);
      });

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (
      input: Parameters<CheckpointRollbackServiceV2Shape["execute"]>[0],
    ) {
      const projection = yield* projections.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerSessions",
        "checkpoints",
        "checkpointScopes",
        "runs",
        "attempts",
        "nodes",
        "providerTurns",
      ]);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId,
      );
      const scope = projection.checkpointScopes.find((candidate) => candidate.id === input.scopeId);
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id ||
        checkpoint.status !== "ready"
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (
        providerThread.id !== projection.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== projection.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      const rollbackTarget: ProviderAdapter.ProviderAdapterV2RollbackTarget =
        targetOrdinal === 0
          ? {
              type: "thread_start",
              checkpointId: checkpoint.id,
              appRunOrdinal: 0,
            }
          : yield* Effect.gen(function* () {
              const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
              // Its checkpoint stays ready while an earlier rollback finishes restoring files.
              if (targetRun?.status === "rolled_back") {
                return yield* new CheckpointRollbackExecutionError({
                  reason: "rollback-target-invalid",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              const targetAttempt = projection.attempts.find(
                (attempt) => attempt.id === targetRun?.activeAttemptId,
              );
              const targetTurn =
                latestProviderTurnForAttempt(projection.providerTurns, targetAttempt?.id) ??
                projection.providerTurns.find((turn) => turn.id === targetAttempt?.providerTurnId);
              if (targetTurn === undefined || targetTurn.providerThreadId !== providerThread.id) {
                return yield* new CheckpointRollbackExecutionError({
                  reason: "provider-turn-unavailable",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              return {
                type: "provider_turn" as const,
                checkpointId: checkpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
              };
            });

      const { worktreePath, branch } = projection.thread;
      if (worktreePath != null && branch != null && !(yield* fileSystem.exists(worktreePath))) {
        const project = yield* projects.get(projection.thread.projectId);
        if (Option.isSome(project)) {
          yield* gitWorkflow.pruneWorktrees({ cwd: project.value.workspaceRoot });
          yield* gitWorkflow.createWorktree({
            cwd: project.value.workspaceRoot,
            refName: branch,
            path: worktreePath,
          });
        }
      }

      const plan =
        input.restoreFiles === false
          ? null
          : yield* planCheckpointRestore(
              {
                thread: projection.thread,
                scope,
                checkpoint,
                checkpoints: projection.checkpoints,
              },
              { fileSystem, projections, projects, path },
            );
      const refusal = {
        threadId: input.threadId,
        providerThreadId: input.providerThreadId,
        checkpointId: input.checkpointId,
      };
      if (plan?._tag === "shared-workspace") {
        return yield* new CheckpointRollbackExecutionError({
          ...refusal,
          reason: "shared-workspace",
        });
      }
      if (plan?._tag === "shared-repository") {
        return yield* new CheckpointRollbackExecutionError({
          ...refusal,
          reason: "shared-repository",
          repository: plan.repository.repository,
          worktreePath: plan.repository.worktreePath,
        });
      }
      // Every repository is checked before the provider or any file changes.
      const repositoryTargets =
        plan === null
          ? []
          : yield* Effect.forEach(plan.repositories, (repository) =>
              prepareRepositoryRestore({
                repository,
                history: {
                  scopeId: scope.id,
                  checkpoints: projection.checkpoints,
                  runs: projection.runs,
                },
                targetOrdinal: checkpoint.ordinalWithinScope,
              }).pipe(
                Effect.catchTags({
                  CheckpointRepositoryUnavailableError: (cause) =>
                    Effect.fail(
                      new CheckpointRollbackExecutionError({
                        ...refusal,
                        reason: "repository-unavailable",
                        repository: cause.repository,
                        worktreePath: cause.worktreePath,
                        repositoryProblem: cause.reason,
                        ...(cause.submodulePath === undefined
                          ? {}
                          : { submodulePath: cause.submodulePath }),
                      }),
                    ),
                }),
              ),
            );

      const modelSelection = projection.thread.modelSelection;
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection,
      });
      const existingSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerThread.providerSessionId,
      );
      const session = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId: providerThread.providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
        ...(providerThread.nativeThreadRef?.nativeId == null
          ? {}
          : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      });

      const runsToRollback = projection.runs.filter(
        (run) =>
          run.ordinal > targetOrdinal &&
          (run.status === "completed" ||
            run.status === "interrupted" ||
            run.status === "failed" ||
            run.status === "cancelled"),
      );
      // Rolled-back turns stay in the audit history, but no longer exist in
      // the provider conversation and must not be counted by a later rewind.
      const rolledBackRunIds = new Set(
        projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
      );
      const rolledBackAttemptIds = new Set(
        projection.attempts
          .filter((attempt) => rolledBackRunIds.has(attempt.runId))
          .map((attempt) => attempt.id),
      );
      const providerThreadTurns = projection.providerTurns.filter(
        (turn) =>
          turn.providerThreadId === providerThread.id &&
          (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
      );

      const snapshot =
        runsToRollback.length === 0
          ? { providerThread }
          : yield* session.rollbackThread({
              providerThread,
              target: rollbackTarget,
              providerThreadTurns,
            });
      const staleCheckpoints = projection.checkpoints.filter(
        (candidate) =>
          candidate.scopeId === scope.id &&
          candidate.appRunOrdinal !== null &&
          candidate.appRunOrdinal > targetOrdinal &&
          candidate.status === "ready",
      );
      // An earlier attempt that rewound the conversation, then stopped
      // restoring files, left its runs rolled back with ready checkpoints.
      const conversationRewound =
        runsToRollback.length > 0 ||
        staleCheckpoints.some(
          (candidate) => candidate.runId !== null && rolledBackRunIds.has(candidate.runId),
        );
      const restoreFilesAndCleanUp = Effect.gen(function* () {
        if (plan?._tag === "restore" && plan.workspace) {
          yield* checkpoints.restore({ scope, checkpoint }).pipe(
            Effect.mapError(
              (cause) =>
                new CheckpointRollbackExecutionError({
                  ...refusal,
                  reason: "workspace-restore-failed",
                  worktreePath: scope.cwd,
                  conversationRewound,
                  cause,
                }),
            ),
          );
        }
        // In order, stopping at the first failure: the worktrees not reached
        // keep their files, and the error names the ones already restored.
        const restoredRepositories: Array<string> = [];
        for (const target of repositoryTargets) {
          yield* Effect.gen(function* () {
            if (target.recreate && target.repository.branch !== null) {
              yield* gitWorkflow.pruneWorktrees({ cwd: target.repository.repositoryPath });
              yield* gitWorkflow.createWorktree({
                cwd: target.repository.repositoryPath,
                refName: target.repository.branch,
                path: target.repository.worktreePath,
              });
            }
            yield* checkpoints.restoreRepository({
              repository: target.repository,
              ref: target.ref,
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CheckpointRollbackExecutionError({
                  ...refusal,
                  reason: "repository-restore-failed",
                  repository: target.repository.repository,
                  worktreePath: target.repository.worktreePath,
                  restoredRepositories: [...restoredRepositories],
                  conversationRewound,
                  cause,
                }),
            ),
          );
          restoredRepositories.push(target.repository.repository);
        }
        if (staleCheckpoints.length > 0) {
          const staleIds = new Set(staleCheckpoints.map((candidate) => candidate.id));
          yield* checkpoints.deleteStaleRefs({
            scope,
            checkpoints: staleCheckpoints,
            keep: projection.checkpoints.filter(
              (candidate) =>
                candidate.scopeId === scope.id &&
                candidate.status !== "stale" &&
                !staleIds.has(candidate.id),
            ),
          });
        }
      });

      const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
        Effect.map(
          ids.allocate.event({ threadId: event.threadId }),
          (id) =>
            ({
              ...event,
              id,
            }) as Event,
        );
      // Thread commands write full provider thread rows under this lock. Without
      // it, a message sent during the rollback can plan against the old native
      // session and commit after this, undoing the provider's fork.
      //
      // A commit before the files are restored records only the conversation,
      // with the failure in the same write, so no client reads the rewind as
      // finished. Its checkpoints stay ready, so a retry restores the same
      // files and the provider has nothing left to remove.
      const commit = (outcome: { readonly complete: boolean; readonly failure?: string }) =>
        threadCommands.withLock(
          input.threadId,
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events: Array<OrchestrationV2DomainEvent> = [];
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
            for (const staleCheckpoint of outcome.complete ? staleCheckpoints : []) {
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
              const rootNode = projection.nodes.find(
                (candidate) => candidate.id === run.rootNodeId,
              );
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
            // A retry that finishes clears the failure an earlier attempt recorded.
            const { requestId } = input;
            const thread =
              requestId === undefined ? undefined : yield* projections.getThread(input.threadId);
            let rollbackFailure: OrchestrationV2AppThread["rollbackFailure"];
            if (thread !== undefined && requestId !== undefined) {
              if (outcome.complete) {
                if (thread.rollbackFailure?.requestId === requestId) rollbackFailure = null;
              } else if (outcome.failure !== undefined && thread.rollbackRequestId === requestId) {
                rollbackFailure = { requestId, message: outcome.failure };
              }
            }
            if (thread !== undefined && rollbackFailure !== undefined) {
              events.push(
                yield* makeEvent({
                  type: "thread.metadata-updated",
                  threadId: input.threadId,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: now,
                  payload: { ...thread, rollbackFailure, updatedAt: now },
                }),
              );
            }
            yield* eventSink.write({ events });
          }),
        );

      yield* restoreFilesAndCleanUp.pipe(
        Effect.tapError((error) =>
          runsToRollback.length === 0
            ? Effect.void
            : commit({
                complete: false,
                ...(isCheckpointRollbackExecutionError(error) && isFileRestoreRefusal(error)
                  ? { failure: error.message }
                  : {}),
              }),
        ),
      );
      yield* commit({ complete: true });
    });

    return CheckpointRollbackServiceV2.of({
      execute: (input) =>
        Effect.gen(function* () {
          // Storage cleanup removes worktrees under the same lease.
          const { thread } = yield* projections.getThreadRecords(input.threadId, []);
          const locked = Effect.gen(function* () {
            const keys = yield* repositoryLeaseKeys(input);
            yield* keys.length === 0 ? execute(input) : withRepositoryLeases(keys, execute(input));
          });
          yield* thread.worktreePath === null
            ? locked
            : withWorkspaceLease(path.resolve(thread.worktreePath), locked);
        }).pipe(
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
    });
  }),
);
