import {
  checkpointRollbackAppRunOrdinal,
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2DomainEvent,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  CheckpointRestoreOutcomeUnknownError,
  CheckpointRestorePreflightError,
  CheckpointRestorePreconditionError,
  CheckpointServiceV2,
} from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ThreadDispatchLockV2 } from "./KeyedSerialExecutor.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RollbackTarget } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

const CheckpointRollbackErrorFields = {
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  checkpointId: CheckpointId,
  cause: Schema.optional(Schema.Defect()),
};

export class CheckpointRollbackRejectedError extends Schema.TaggedErrorClass<CheckpointRollbackRejectedError>()(
  "CheckpointRollbackRejectedError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "rollback-target-ambiguous",
      "active-provider-changed",
      "provider-turn-unavailable",
      "thread-not-idle",
      "restore-precondition-changed",
    ]),
    ...CheckpointRollbackErrorFields,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "rollback-target-ambiguous":
        return `Rollback target ${this.checkpointId} does not identify a proven provider-history position.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "thread-not-idle":
        return `Checkpoint rollback target ${this.checkpointId} requires an idle thread with no queued runs.`;
      case "restore-precondition-changed":
        return `Checkpoint rollback target ${this.checkpointId} changed before filesystem restoration began.`;
    }
  }
}

export class CheckpointRollbackPartialError extends Schema.TaggedErrorClass<CheckpointRollbackPartialError>()(
  "CheckpointRollbackPartialError",
  {
    reason: Schema.Literals([
      "provider-rollback-failed-after-restore",
      "post-restore-finalization-failed",
    ]),
    ...CheckpointRollbackErrorFields,
  },
) {
  override get message(): string {
    return this.reason === "provider-rollback-failed-after-restore"
      ? `Provider conversation rollback failed after the filesystem checkpoint ${this.checkpointId} was restored; the result is partial.`
      : `Checkpoint ${this.checkpointId} was restored, but rollback finalization failed; the result is partial.`;
  }
}

export class CheckpointRollbackPreflightError extends Schema.TaggedErrorClass<CheckpointRollbackPreflightError>()(
  "CheckpointRollbackPreflightError",
  {
    ...CheckpointRollbackErrorFields,
  },
) {
  override get message(): string {
    return `Failed to execute rollback target ${this.checkpointId} on provider thread ${this.providerThreadId} for thread ${this.threadId}.`;
  }
}

export const CheckpointRollbackExecutionError = Schema.Union([
  CheckpointRollbackRejectedError,
  CheckpointRollbackPartialError,
  CheckpointRollbackPreflightError,
]);
export type CheckpointRollbackExecutionError = typeof CheckpointRollbackExecutionError.Type;

const isCheckpointRollbackPartialError = Schema.is(CheckpointRollbackPartialError);
const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);
const isCheckpointRestoreOutcomeUnknownError = Schema.is(CheckpointRestoreOutcomeUnknownError);
const isCheckpointRestorePreflightError = Schema.is(CheckpointRestorePreflightError);
const isCheckpointRestorePreconditionError = Schema.is(CheckpointRestorePreconditionError);

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly expectedIdle?: true;
    readonly expectedWorkspaceFingerprint?: string;
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
  | EventSinkV2
  | IdAllocatorV2
  | ThreadDispatchLockV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const threadDispatch = yield* ThreadDispatchLockV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly expectedIdle?: true;
      readonly expectedWorkspaceFingerprint?: string;
    }) {
      const initialSnapshot = yield* projections.getThreadSnapshot(input.threadId);
      const projection = initialSnapshot.projection;
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
        return yield* new CheckpointRollbackRejectedError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      const providerSessionId = providerThread.providerSessionId;
      if (
        providerThread.id !== projection.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== projection.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackRejectedError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (
        input.expectedIdle === true &&
        projection.runs.some((run) =>
          ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
        )
      ) {
        return yield* new CheckpointRollbackRejectedError({
          reason: "thread-not-idle",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const targetOrdinal = checkpointRollbackAppRunOrdinal(checkpoint, scope);
      if (targetOrdinal === null) {
        return yield* new CheckpointRollbackRejectedError({
          reason: "rollback-target-ambiguous",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const modelSelection = projection.thread.modelSelection;
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection,
      });
      const existingSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const session = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
      });

      const admittedSnapshot = yield* projections.getThreadSnapshot(input.threadId);
      const admittedProjection = admittedSnapshot.projection;
      const admittedProviderThread = admittedProjection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const admittedCheckpoint = admittedProjection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId,
      );
      const admittedScope = admittedProjection.checkpointScopes.find(
        (candidate) => candidate.id === input.scopeId,
      );
      if (
        admittedProviderThread === undefined ||
        admittedProviderThread.providerSessionId !== providerSessionId ||
        admittedCheckpoint === undefined ||
        admittedScope === undefined ||
        admittedCheckpoint.scopeId !== admittedScope.id ||
        admittedCheckpoint.status !== "ready"
      ) {
        return yield* new CheckpointRollbackRejectedError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (
        admittedProviderThread.id !== admittedProjection.thread.activeProviderThreadId ||
        admittedProviderThread.providerInstanceId !==
          admittedProjection.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackRejectedError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (
        input.expectedIdle === true &&
        admittedProjection.runs.some((run) =>
          ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
        )
      ) {
        return yield* new CheckpointRollbackRejectedError({
          reason: "thread-not-idle",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (checkpointRollbackAppRunOrdinal(admittedCheckpoint, admittedScope) !== targetOrdinal) {
        return yield* new CheckpointRollbackRejectedError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const runsToRollback = admittedProjection.runs.filter(
        (run) => run.ordinal > targetOrdinal && run.status === "completed",
      );
      const providerThreadTurns = admittedProjection.providerTurns.filter(
        (turn) => turn.providerThreadId === admittedProviderThread.id,
      );
      const rollbackTarget: ProviderAdapterV2RollbackTarget =
        targetOrdinal === 0
          ? {
              type: "thread_start",
              checkpointId: admittedCheckpoint.id,
              appRunOrdinal: 0,
            }
          : yield* Effect.gen(function* () {
              const targetRun = admittedProjection.runs.find(
                (run) => run.ordinal === targetOrdinal,
              );
              const targetAttempt = admittedProjection.attempts.find(
                (attempt) => attempt.id === targetRun?.activeAttemptId,
              );
              const targetTurn = admittedProjection.providerTurns.find(
                (turn) =>
                  turn.id === targetAttempt?.providerTurnId ||
                  turn.runAttemptId === targetAttempt?.id,
              );
              if (
                targetTurn === undefined ||
                targetTurn.providerThreadId !== admittedProviderThread.id
              ) {
                return yield* new CheckpointRollbackRejectedError({
                  reason: "provider-turn-unavailable",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              return {
                type: "provider_turn" as const,
                checkpointId: admittedCheckpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
              };
            });

      const validateBeforeRestore =
        input.expectedIdle === true
          ? projections.getThreadSnapshot(input.threadId).pipe(
              Effect.flatMap((latestSnapshot) => {
                const latest = latestSnapshot.projection;
                const latestCheckpoint = latest.checkpoints.find(
                  (candidate) => candidate.id === input.checkpointId,
                );
                const latestProviderThread = latest.providerThreads.find(
                  (candidate) => candidate.id === input.providerThreadId,
                );
                const remainsIdle = !latest.runs.some((run) =>
                  ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
                );
                return remainsIdle &&
                  latestSnapshot.snapshotSequence === admittedSnapshot.snapshotSequence &&
                  latest.thread.archivedAt === null &&
                  latest.thread.deletedAt === null &&
                  latest.thread.activeProviderThreadId === input.providerThreadId &&
                  latest.thread.modelSelection.instanceId ===
                    admittedProviderThread.providerInstanceId &&
                  latestProviderThread?.providerSessionId === providerSessionId &&
                  latestCheckpoint?.scopeId === input.scopeId &&
                  latestCheckpoint.status === "ready"
                  ? Effect.void
                  : Effect.fail(
                      new CheckpointRestorePreconditionError({
                        scopeId: input.scopeId,
                        checkpointId: input.checkpointId,
                        reason: "precondition-changed",
                        cause:
                          "Thread or rollback target changed after admission; current workspace files were preserved.",
                      }),
                    );
              }),
              Effect.mapError((cause) =>
                isCheckpointRestorePreconditionError(cause) ||
                isCheckpointRestorePreflightError(cause)
                  ? cause
                  : new CheckpointRestorePreflightError({
                      scopeId: input.scopeId,
                      checkpointId: input.checkpointId,
                      cause,
                    }),
              ),
            )
          : undefined;
      yield* checkpoints
        .restore({
          scope: admittedScope,
          checkpoint: admittedCheckpoint,
          ...(input.expectedWorkspaceFingerprint === undefined
            ? {}
            : { expectedWorkspaceFingerprint: input.expectedWorkspaceFingerprint }),
          ...(validateBeforeRestore === undefined ? {} : { validateBeforeRestore }),
        })
        .pipe(
          Effect.mapError((cause): CheckpointRollbackExecutionError => {
            const fields = {
              threadId: input.threadId,
              providerThreadId: input.providerThreadId,
              checkpointId: input.checkpointId,
              cause,
            };
            if (isCheckpointRestoreOutcomeUnknownError(cause)) {
              return new CheckpointRollbackPartialError({
                ...fields,
                reason: "post-restore-finalization-failed",
              });
            }
            if (isCheckpointRestorePreconditionError(cause)) {
              return new CheckpointRollbackRejectedError({
                ...fields,
                reason: "restore-precondition-changed",
              });
            }
            return new CheckpointRollbackPreflightError({
              ...fields,
            });
          }),
        );
      yield* Effect.gen(function* () {
        const snapshot =
          runsToRollback.length === 0
            ? { providerThread: admittedProviderThread }
            : yield* session
                .rollbackThread({
                  providerThread: admittedProviderThread,
                  target: rollbackTarget,
                  providerThreadTurns,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new CheckpointRollbackPartialError({
                        reason: "provider-rollback-failed-after-restore",
                        threadId: input.threadId,
                        providerThreadId: input.providerThreadId,
                        checkpointId: input.checkpointId,
                        cause,
                      }),
                  ),
                );
        const staleCheckpoints = admittedProjection.checkpoints.filter(
          (candidate) =>
            candidate.scopeId === admittedScope.id &&
            candidate.appRunOrdinal !== null &&
            candidate.appRunOrdinal > targetOrdinal &&
            candidate.status === "ready",
        );
        if (staleCheckpoints.length > 0) {
          yield* checkpoints.deleteStaleRefs({
            scope: admittedScope,
            checkpoints: staleCheckpoints,
          });
        }

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
        events.push(
          yield* makeEvent({
            type: "provider-thread.updated",
            threadId: input.threadId,
            driver: admittedProviderThread.driver,
            providerInstanceId: admittedProviderThread.providerInstanceId,
            occurredAt: now,
            payload: {
              ...snapshot.providerThread,
              lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
              updatedAt: now,
            },
          }),
        );
        for (const staleCheckpoint of staleCheckpoints) {
          events.push(
            yield* makeEvent({
              type: "checkpoint.captured",
              threadId: input.threadId,
              ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
              nodeId: staleCheckpoint.nodeId,
              providerInstanceId: admittedProviderThread.providerInstanceId,
              occurredAt: now,
              payload: { ...staleCheckpoint, status: "stale" },
            }),
          );
        }
        for (const run of runsToRollback) {
          const rootNode = admittedProjection.nodes.find(
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
        yield* eventSink.write({ events });
      }).pipe(
        Effect.mapError((cause) =>
          isCheckpointRollbackPartialError(cause) &&
          cause.reason === "provider-rollback-failed-after-restore"
            ? cause
            : new CheckpointRollbackPartialError({
                reason: "post-restore-finalization-failed",
                threadId: input.threadId,
                providerThreadId: input.providerThreadId,
                checkpointId: input.checkpointId,
                cause,
              }),
        ),
      );
    });

    return CheckpointRollbackServiceV2.of({
      execute: (input) =>
        threadDispatch.withLock(input.threadId, execute(input)).pipe(
          Effect.mapError((cause) =>
            isCheckpointRollbackExecutionError(cause)
              ? cause
              : new CheckpointRollbackPreflightError({
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
