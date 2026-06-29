import {
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

export class CheckpointCaptureExecutionError extends Schema.TaggedErrorClass<CheckpointCaptureExecutionError>()(
  "CheckpointCaptureExecutionError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface CheckpointCaptureServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scopeId: CheckpointScopeId;
  }) => Effect.Effect<void, CheckpointCaptureExecutionError>;
}

export class CheckpointCaptureServiceV2 extends Context.Service<
  CheckpointCaptureServiceV2,
  CheckpointCaptureServiceV2Shape
>()("t3/orchestration-v2/CheckpointCaptureService/CheckpointCaptureServiceV2") {}

export const layer: Layer.Layer<
  CheckpointCaptureServiceV2,
  never,
  CheckpointServiceV2 | EventSinkV2 | IdAllocatorV2 | ProjectionStoreV2
> = Layer.effect(
  CheckpointCaptureServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;

    const execute = Effect.fn("orchestrationV2.checkpointCapture.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) {
      const projection = yield* projections.getThreadProjection(input.threadId);
      const run = projection.runs.find((candidate) => candidate.id === input.runId);

      // The effect is at-least-once. A completed run with a checkpoint proves
      // that an earlier execution committed its result.
      if (run?.status === "completed" && run.checkpointId !== null) {
        return;
      }

      const rootNode = projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
      const scope = projection.checkpointScopes.find((candidate) => candidate.id === input.scopeId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run?.providerThreadId,
      );
      if (
        run === undefined ||
        run.status !== "waiting" ||
        rootNode === undefined ||
        scope === undefined ||
        rootNode.checkpointScopeId !== scope.id ||
        providerThread === undefined
      ) {
        return yield* new CheckpointCaptureExecutionError({
          threadId: input.threadId,
          runId: input.runId,
          scopeId: input.scopeId,
          cause: "The persisted checkpoint capture target is incomplete or no longer waiting.",
        });
      }

      const capturedAt = yield* DateTime.now;
      const baselineCheckpoint = projection.checkpoints.some(
        (candidate) => candidate.scopeId === scope.id && candidate.ordinalWithinScope === 0,
      )
        ? null
        : yield* checkpoints.materializeBaselineCheckpoint({ scope });
      const checkpoint = yield* checkpoints.capture({
        scope,
        runId: run.id,
        nodeId: rootNode.id,
        ordinalWithinScope: run.ordinal,
        appRunOrdinal: run.ordinal,
        capturedAt,
      });
      const commandId = CommandId.make(`command:effect:checkpoint.capture:${run.id}`);
      yield* eventSink.commitCommand({
        commandId,
        threadId: input.threadId,
        commandType: "checkpoint.capture",
        acceptedAt: capturedAt,
        effects: [],
        events: [
          ...(baselineCheckpoint === null
            ? []
            : [
                {
                  id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                  type: "checkpoint.captured" as const,
                  threadId: input.threadId,
                  nodeId: baselineCheckpoint.nodeId,
                  driver: providerThread.driver,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: capturedAt,
                  payload: baselineCheckpoint,
                },
              ]),
          {
            id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
            type: "checkpoint.captured",
            threadId: input.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            driver: providerThread.driver,
            providerInstanceId: run.providerInstanceId,
            occurredAt: capturedAt,
            payload: checkpoint,
          },
          {
            id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
            type: "turn-item.updated",
            threadId: input.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            driver: providerThread.driver,
            providerInstanceId: run.providerInstanceId,
            occurredAt: capturedAt,
            payload: makeCheckpointTurnItem({
              idAllocator: ids,
              run,
              rootNode,
              providerThread,
              checkpoint,
              completedAt: capturedAt,
            }),
          },
          {
            id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
            type: "run.updated",
            threadId: input.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: capturedAt,
            payload: {
              ...run,
              status: "completed",
              completedAt: capturedAt,
              checkpointId: checkpoint.id,
            },
          },
          {
            id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
            type: "node.updated",
            threadId: input.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: capturedAt,
            payload: {
              ...rootNode,
              status: "completed",
              completedAt: capturedAt,
              checkpointScopeId: scope.id,
            },
          },
        ],
      });
    });

    return CheckpointCaptureServiceV2.of({
      execute: (input) =>
        execute(input).pipe(
          Effect.mapError((cause) =>
            Schema.is(CheckpointCaptureExecutionError)(cause)
              ? cause
              : new CheckpointCaptureExecutionError({ ...input, cause }),
          ),
        ),
    });
  }),
);

function makeCheckpointTurnItem(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly completedAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.turnItemFromProviderItem({
      driver: input.providerThread.driver,
      nativeItemId: `checkpoint:${input.checkpoint.id}`,
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.run.ordinal * 100 + 99,
    status: "completed",
    title: null,
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "checkpoint",
    checkpointId: input.checkpoint.id,
    scopeId: input.checkpoint.scopeId,
    files: input.checkpoint.files,
  };
}
