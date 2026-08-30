import {
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

import { CheckpointRestoreError, CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RollbackTarget } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export class CheckpointRollbackExecutionError extends Schema.TaggedErrorClass<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "thread-not-idle",
      "provider-rollback-failed-after-restore",
      "unexpected-failure",
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
      case "thread-not-idle":
        return `Checkpoint rollback target ${this.checkpointId} requires an idle thread with no queued runs.`;
      case "provider-rollback-failed-after-restore":
        return `Provider conversation rollback failed after the filesystem checkpoint ${this.checkpointId} was restored; the result is partial.`;
      case "unexpected-failure":
        return `Failed to execute rollback target ${this.checkpointId} on provider thread ${this.providerThreadId} for thread ${this.threadId}.`;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);
const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

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
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
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
      const projection = yield* projections.getThreadProjection(input.threadId);
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
      if (
        input.expectedIdle === true &&
        projection.runs.some((run) =>
          ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
        )
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "thread-not-idle",
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
        (candidate) => candidate.id === providerThread.providerSessionId,
      );
      const session = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId: providerThread.providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
      });

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      const runsToRollback = projection.runs.filter(
        (run) => run.ordinal > targetOrdinal && run.status === "completed",
      );
      const providerThreadTurns = projection.providerTurns.filter(
        (turn) => turn.providerThreadId === providerThread.id,
      );
      const rollbackTarget: ProviderAdapterV2RollbackTarget =
        targetOrdinal === 0
          ? {
              type: "thread_start",
              checkpointId: checkpoint.id,
              appRunOrdinal: 0,
            }
          : yield* Effect.gen(function* () {
              const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
              const targetAttempt = projection.attempts.find(
                (attempt) => attempt.id === targetRun?.activeAttemptId,
              );
              const targetTurn = projection.providerTurns.find(
                (turn) =>
                  turn.id === targetAttempt?.providerTurnId ||
                  turn.runAttemptId === targetAttempt?.id,
              );
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

      const validateBeforeRestore =
        input.expectedIdle === true
          ? projections.getThreadProjection(input.threadId).pipe(
              Effect.flatMap((latest) => {
                const latestCheckpoint = latest.checkpoints.find(
                  (candidate) => candidate.id === input.checkpointId,
                );
                const remainsIdle = !latest.runs.some((run) =>
                  ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
                );
                return remainsIdle &&
                  latest.thread.archivedAt === null &&
                  latest.thread.deletedAt === null &&
                  latest.thread.activeProviderThreadId === input.providerThreadId &&
                  latestCheckpoint?.scopeId === input.scopeId &&
                  latestCheckpoint.status === "ready"
                  ? Effect.void
                  : Effect.fail(
                      new CheckpointRestoreError({
                        scopeId: input.scopeId,
                        checkpointId: input.checkpointId,
                        cause:
                          "Thread or rollback target changed after admission; current workspace files were preserved.",
                      }),
                    );
              }),
              Effect.mapError((cause) =>
                isCheckpointRestoreError(cause)
                  ? cause
                  : new CheckpointRestoreError({
                      scopeId: input.scopeId,
                      checkpointId: input.checkpointId,
                      cause,
                    }),
              ),
            )
          : undefined;
      yield* checkpoints.restore({
        scope,
        checkpoint,
        ...(input.expectedWorkspaceFingerprint === undefined
          ? {}
          : { expectedWorkspaceFingerprint: input.expectedWorkspaceFingerprint }),
        ...(validateBeforeRestore === undefined ? {} : { validateBeforeRestore }),
      });
      const snapshot =
        runsToRollback.length === 0
          ? { providerThread }
          : yield* session
              .rollbackThread({
                providerThread,
                target: rollbackTarget,
                providerThreadTurns,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new CheckpointRollbackExecutionError({
                      reason: "provider-rollback-failed-after-restore",
                      threadId: input.threadId,
                      providerThreadId: input.providerThreadId,
                      checkpointId: input.checkpointId,
                      cause,
                    }),
                ),
              );
      const staleCheckpoints = projection.checkpoints.filter(
        (candidate) =>
          candidate.scopeId === scope.id &&
          candidate.appRunOrdinal !== null &&
          candidate.appRunOrdinal > targetOrdinal &&
          candidate.status === "ready",
      );
      if (staleCheckpoints.length > 0) {
        yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleCheckpoints });
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
        const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
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
    });

    return CheckpointRollbackServiceV2.of({
      execute: (input) =>
        execute(input).pipe(
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
