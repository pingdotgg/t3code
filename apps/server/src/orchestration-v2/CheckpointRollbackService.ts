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

import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RollbackTarget } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export class CheckpointRollbackExecutionError extends Schema.TaggedErrorClass<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
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
        checkpoint.scopeId !== scope.id
      ) {
        return yield* new CheckpointRollbackExecutionError({
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          cause: "The persisted rollback target is incomplete or no longer valid.",
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
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                  cause: "The provider rollback turn is unavailable.",
                });
              }
              return {
                type: "provider_turn" as const,
                checkpointId: checkpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
              };
            });

      yield* checkpoints.restore({ scope, checkpoint });
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
            Schema.is(CheckpointRollbackExecutionError)(cause)
              ? cause
              : new CheckpointRollbackExecutionError({
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
