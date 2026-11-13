import {
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";

// Git processes are already capped server-wide; this keeps one thread from taking every slot.
const REPOSITORY_CAPTURE_CONCURRENCY = 6;

export class CheckpointCaptureExecutionError extends Schema.TaggedError<CheckpointCaptureExecutionError>()(
  "CheckpointCaptureExecutionError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isCheckpointCaptureExecutionError = Schema.is(CheckpointCaptureExecutionError);

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
  | CheckpointService.CheckpointServiceV2
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStore.ProjectionStoreV2
> = Layer.effect(
  CheckpointCaptureServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;

    const execute = Effect.fn("orchestrationV2.checkpointCapture.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) {
      const context = yield* projections.getCheckpointCaptureContext(input.threadId, input);
      const { run, rootNode, scope, providerThread, preservedCheckpointOrdinals, sideChat } =
        context;
      // Stopped runs remain terminal; their checkpoint is the next message's rollback point.
      const stopped = run?.status === "interrupted" || run?.status === "cancelled";

      // A checkpoint on a settled run proves this at-least-once effect already committed.
      if (
        run !== undefined &&
        run.checkpointId !== null &&
        (run.status === "completed" || stopped)
      ) {
        return;
      }
      // Rollback uses the same lane and can precede a capture retry; preserve the restored workspace and discarded run.
      if (run?.status === "rolled_back") {
        return;
      }

      if (
        run === undefined ||
        (run.status !== "waiting" && !stopped) ||
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
      const baselineOrdinalWithinScope = Math.max(0, run.ordinal - 1);
      const isPreserved = (ordinalWithinScope: number) =>
        preservedCheckpointOrdinals.includes(ordinalWithinScope);
      // The baselines this capture materializes are attributed to the run materializing them. The
      // thread's scope may already be a later run's: one queued meanwhile, or sent after Stop.
      const materializeBaseline = (ordinalWithinScope: number) =>
        checkpoints.materializeBaselineCheckpoint({
          scope,
          ordinalWithinScope,
          nodeId: rootNode.id,
          capturedAt: run.requestedAt,
          forceMissing: sideChat,
        });
      // The tracked Git folders the thread reaches now. One added since the turn began has no
      // baseline, so its first checkpoint lists no files; one removed is simply not captured.
      const repositoryScopes =
        sideChat || context.thread === undefined
          ? []
          : yield* checkpoints.repositoryScopes({ rootScope: scope, ...context.thread });
      const nested =
        repositoryScopes.length === 0
          ? undefined
          : yield* checkpoints.nestedScopePaths([scope, ...repositoryScopes]);
      const excluded = (target: OrchestrationV2CheckpointScope) => {
        const excludePaths = nested?.get(target.id);
        return excludePaths === undefined ? {} : { excludePaths };
      };
      // Each scope is checked on its own, so a retried capture fills only what is missing.
      const captureRoot = Effect.gen(function* () {
        const threadStartCheckpoint =
          baselineOrdinalWithinScope === 0 || isPreserved(0) ? null : yield* materializeBaseline(0);
        const baselineCheckpoint = isPreserved(baselineOrdinalWithinScope)
          ? null
          : yield* materializeBaseline(baselineOrdinalWithinScope);
        const checkpoint = yield* checkpoints.capture({
          scope,
          runId: run.id,
          nodeId: rootNode.id,
          ordinalWithinScope: run.ordinal,
          appRunOrdinal: run.ordinal,
          capturedAt,
          forceMissing: sideChat,
          ...excluded(scope),
        });
        return { threadStartCheckpoint, baselineCheckpoint, checkpoint };
      });
      const recordedScopes = new Map(
        context.repositoryScopes.map((recorded) => [recorded.id, recorded]),
      );
      const captureRepository = Effect.fnUntraced(function* (
        prepared: OrchestrationV2CheckpointScope,
      ) {
        const recorded = recordedScopes.get(prepared.id);
        // A recorded scope keeps the run that first used it; only a renamed folder rewrites it.
        const changed =
          recorded === undefined ||
          recorded.cwd !== prepared.cwd ||
          recorded.label !== prepared.label;
        const target =
          recorded === undefined
            ? prepared
            : changed
              ? {
                  ...prepared,
                  runId: recorded.runId,
                  nodeId: recorded.nodeId,
                  createdAt: recorded.createdAt,
                }
              : recorded;
        const captured = yield* checkpoints.captureRepository({
          scope: target,
          runId: run.id,
          nodeId: rootNode.id,
          ordinalWithinScope: run.ordinal,
          capturedAt,
          baselineCapturedAt: run.requestedAt,
          baselineRecorded: context.repositoryScopesWithBaseline.includes(target.id),
          ...excluded(target),
        });
        // Only a repository with something to show is recorded, so the rest cost no events,
        // rows or bytes on the wire.
        return Option.match(captured, {
          onNone: () => [],
          onSome: (capture) => [{ scope: changed ? target : null, ...capture }],
        });
      });
      const [{ threadStartCheckpoint, baselineCheckpoint, checkpoint }, repositoryCaptures] =
        yield* Effect.all(
          [
            captureRoot,
            Effect.forEach(repositoryScopes, captureRepository, {
              concurrency: REPOSITORY_CAPTURE_CONCURRENCY,
            }),
          ],
          { concurrency: 2 },
        );
      // Omit delegatedCompletion to preserve cohort writes made after capture loaded the run.
      const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } = run;
      const commandId = CommandId.make(`command:effect:checkpoint.capture:${run.id}`);
      const checkpointEvent = (payload: OrchestrationV2Checkpoint) =>
        Effect.map(ids.allocate.event({ threadId: input.threadId, commandId }), (id) => ({
          id,
          type: "checkpoint.captured" as const,
          threadId: input.threadId,
          ...(payload.runId === null ? {} : { runId: payload.runId }),
          nodeId: payload.nodeId,
          driver: providerThread.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: capturedAt,
          payload,
        }));
      const repositoryEvents = yield* Effect.forEach(repositoryCaptures.flat(), (capture) =>
        Effect.gen(function* () {
          return [
            ...(capture.scope === null
              ? []
              : [
                  {
                    id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                    type: "checkpoint-scope.created" as const,
                    threadId: input.threadId,
                    runId: run.id,
                    nodeId: rootNode.id,
                    providerInstanceId: run.providerInstanceId,
                    occurredAt: capturedAt,
                    payload: capture.scope,
                  },
                ]),
            ...(capture.baseline === null ? [] : [yield* checkpointEvent(capture.baseline)]),
            yield* checkpointEvent(capture.checkpoint),
          ];
        }),
      );
      yield* eventSink.commitCommand({
        commandId,
        threadId: input.threadId,
        commandType: "checkpoint.capture",
        acceptedAt: capturedAt,
        effects: [],
        events: [
          // Root records come last: a client that takes the latest ordinal-0 baseline gets the thread's.
          ...repositoryEvents.flat(),
          ...(threadStartCheckpoint === null
            ? []
            : [
                {
                  id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                  type: "checkpoint.captured" as const,
                  threadId: input.threadId,
                  nodeId: threadStartCheckpoint.nodeId,
                  driver: providerThread.driver,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: capturedAt,
                  payload: threadStartCheckpoint,
                },
              ]),
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
            payload: stopped
              ? { ...runWithoutDelegatedCompletion, checkpointId: checkpoint.id }
              : {
                  ...runWithoutDelegatedCompletion,
                  status: "completed",
                  completedAt: capturedAt,
                  checkpointId: checkpoint.id,
                },
          },
          ...(stopped
            ? []
            : [
                {
                  id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                  type: "node.updated" as const,
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: rootNode.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: capturedAt,
                  payload: {
                    ...rootNode,
                    status: "completed" as const,
                    completedAt: capturedAt,
                    checkpointScopeId: scope.id,
                  },
                },
              ]),
        ],
      });
    });

    return CheckpointCaptureServiceV2.of({
      execute: Effect.fn("CheckpointCaptureServiceV2.execute")(function (input) {
        return execute(input).pipe(
          Effect.mapError((cause) =>
            isCheckpointCaptureExecutionError(cause)
              ? cause
              : new CheckpointCaptureExecutionError({ ...input, cause }),
          ),
        );
      }),
    });
  }),
);

function makeCheckpointTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
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
