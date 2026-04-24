import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type RunAttemptId,
} from "@t3tools/contracts";
import { Context, DateTime, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect";

import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "./IdAllocator.ts";
import type {
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnMessage,
} from "./ProviderAdapter.ts";
import { ProviderEventIngestorV2 } from "./ProviderEventIngestor.ts";

/**
 * ERRORS
 */
export class RunExecutionStartError extends Schema.TaggedErrorClass<RunExecutionStartError>()(
  "RunExecutionStartError",
  {
    commandId: CommandId,
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to start orchestration V2 run execution ${this.runId}.`;
  }
}

export class RunExecutionIngestError extends Schema.TaggedErrorClass<RunExecutionIngestError>()(
  "RunExecutionIngestError",
  {
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed while ingesting orchestration V2 run execution ${this.runId}.`;
  }
}

export const RunExecutionServiceV2Error = Schema.Union([
  RunExecutionStartError,
  RunExecutionIngestError,
]);
export type RunExecutionServiceV2Error = typeof RunExecutionServiceV2Error.Type;

/**
 * SERVICE DEFINITION
 */
export interface RunExecutionServiceV2StartRootRunInput {
  readonly commandId: CommandId;
  readonly providerSessionId: ProviderSessionId;
  readonly session: ProviderAdapterV2SessionRuntime;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly checkpointScope: OrchestrationV2CheckpointScope;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly attemptId: RunAttemptId;
  readonly shouldFinalizeRun?: () => Effect.Effect<boolean, never>;
  readonly message: ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
}

export interface RunExecutionServiceV2Shape {
  readonly startRootRun: (
    input: RunExecutionServiceV2StartRootRunInput,
  ) => Effect.Effect<void, RunExecutionServiceV2Error>;
}

export class RunExecutionServiceV2 extends Context.Service<
  RunExecutionServiceV2,
  RunExecutionServiceV2Shape
>()("t3/orchestration-v2/RunExecutionService") {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<
  RunExecutionServiceV2,
  never,
  CheckpointServiceV2 | EventSinkV2 | IdAllocatorV2 | ProviderEventIngestorV2
> = Layer.effect(
  RunExecutionServiceV2,
  Effect.gen(function* () {
    const checkpointService = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const idAllocator = yield* IdAllocatorV2;
    const providerEventIngestor = yield* ProviderEventIngestorV2;

    const writeFinalRunEvents = (input: {
      readonly run: OrchestrationV2Run;
      readonly rootNode: OrchestrationV2ExecutionNode;
      readonly checkpointScope: OrchestrationV2CheckpointScope;
      readonly providerThread: OrchestrationV2ProviderThread;
      readonly attempt: OrchestrationV2RunAttempt;
      readonly shouldFinalizeRun?: () => Effect.Effect<boolean, never>;
      readonly status: Extract<
        OrchestrationV2Run["status"],
        "completed" | "interrupted" | "failed" | "cancelled"
      >;
      readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
    }) =>
      Effect.gen(function* () {
        const completedAt = yield* DateTime.now;
        const finalizedAttempt: OrchestrationV2RunAttempt | null = {
          ...input.attempt,
          status: input.status,
          completedAt,
        };
        const shouldFinalizeRun =
          input.shouldFinalizeRun === undefined ? true : yield* input.shouldFinalizeRun();
        if (!shouldFinalizeRun) {
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                type: "run-attempt.updated" as const,
                threadId: input.run.threadId,
                runId: input.run.id,
                nodeId: input.rootNode.id,
                provider: input.run.provider,
                occurredAt: completedAt,
                payload: finalizedAttempt,
              },
            ],
          });
          return;
        }
        const checkpoint =
          input.status === "completed"
            ? yield* checkpointService.capture({
                scope: input.checkpointScope,
                runId: input.run.id,
                nodeId: input.rootNode.id,
                ordinalWithinScope: input.run.ordinal,
                appRunOrdinal: input.run.ordinal,
                capturedAt: completedAt,
              })
            : null;
        const finalizedRun: OrchestrationV2Run = {
          ...input.run,
          status: input.status,
          completedAt,
          checkpointId: checkpoint?.id ?? input.run.checkpointId,
        };
        const finalizedRootNode: OrchestrationV2ExecutionNode = {
          ...input.rootNode,
          status: input.status,
          completedAt,
          checkpointScopeId: input.checkpointScope.id,
        };
        const finalizedProviderThread: OrchestrationV2ProviderThread = {
          ...input.providerThread,
          status: "idle",
          updatedAt: completedAt,
        };
        const runEventId = yield* idAllocator.allocate.event({ threadId: input.run.threadId });
        const nodeEventId = yield* idAllocator.allocate.event({ threadId: input.run.threadId });
        const providerThreadEventId = yield* idAllocator.allocate.event({
          threadId: input.run.threadId,
        });
        yield* eventSink.write({
          events: [
            ...(finalizedAttempt === null
              ? []
              : [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                    type: "run-attempt.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    provider: input.run.provider,
                    occurredAt: completedAt,
                    payload: finalizedAttempt,
                  },
                ]),
            ...(checkpoint === null
              ? []
              : [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                    type: "checkpoint.captured" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    provider: input.run.provider,
                    occurredAt: completedAt,
                    payload: checkpoint,
                  },
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    provider: input.run.provider,
                    occurredAt: completedAt,
                    payload: makeCheckpointTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      checkpoint,
                      completedAt,
                    }),
                  },
                ]),
            ...(input.status === "interrupted"
              ? [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    provider: input.run.provider,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      completedAt,
                    }),
                  },
                ]
              : []),
            {
              id: runEventId,
              type: "run.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              provider: input.run.provider,
              occurredAt: completedAt,
              payload: finalizedRun,
            },
            {
              id: nodeEventId,
              type: "node.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              provider: input.run.provider,
              occurredAt: completedAt,
              payload: finalizedRootNode,
            },
            {
              id: providerThreadEventId,
              type: "provider-thread.updated",
              threadId: input.run.threadId,
              provider: input.run.provider,
              occurredAt: completedAt,
              payload: finalizedProviderThread,
            },
          ],
        });
      });

    return RunExecutionServiceV2.of({
      startRootRun: (input) =>
        Effect.gen(function* () {
          const terminalStatus = yield* Ref.make<Extract<
            OrchestrationV2Run["status"],
            "completed" | "interrupted" | "failed" | "cancelled"
          > | null>(null);
          const providerEventFiber = yield* input.session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                yield* providerEventIngestor.ingestNormalized({
                  providerSessionId: input.providerSessionId,
                  threadId: input.run.threadId,
                  runId: input.run.id,
                  nodeId: input.rootNode.id,
                  event,
                });
                if (event.type === "turn.terminal") {
                  yield* Ref.set(terminalStatus, event.status);
                }
              }),
            ),
            Effect.mapError((cause) => new RunExecutionIngestError({ runId: input.run.id, cause })),
            Effect.flatMap(() =>
              Effect.gen(function* () {
                const status = yield* Ref.get(terminalStatus);
                if (status === null) {
                  return;
                }
                yield* writeFinalRunEvents({
                  run: input.run,
                  rootNode: input.rootNode,
                  checkpointScope: input.checkpointScope,
                  providerThread: input.providerThread,
                  attempt: input.attempt,
                  status,
                  runtimePolicy: input.runtimePolicy,
                }).pipe(
                  Effect.mapError(
                    (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
                  ),
                );
              }),
            ),
            Effect.catchCause((cause) =>
              writeFinalRunEvents({
                run: input.run,
                rootNode: input.rootNode,
                checkpointScope: input.checkpointScope,
                providerThread: input.providerThread,
                attempt: input.attempt,
                status: "failed",
                runtimePolicy: input.runtimePolicy,
              }).pipe(
                Effect.mapError(
                  (writeCause) =>
                    new RunExecutionIngestError({
                      runId: input.run.id,
                      cause: { ingest: cause, write: writeCause },
                    }),
                ),
              ),
            ),
            Effect.forkDetach,
          );

          yield* checkpointService
            .captureBaseline({
              scope: input.checkpointScope,
              ordinalWithinScope: Math.max(0, input.run.ordinal - 1),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new RunExecutionStartError({
                    commandId: input.commandId,
                    runId: input.run.id,
                    cause,
                  }),
              ),
            );

          yield* input.session
            .startTurn({
              threadId: input.run.threadId,
              runId: input.run.id,
              runOrdinal: input.run.ordinal,
              attemptId: input.attemptId,
              rootNodeId: input.rootNode.id,
              providerThread: input.providerThread,
              message: input.message,
              modelSelection: input.modelSelection,
              runtimePolicy: input.runtimePolicy,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Fiber.interrupt(providerEventFiber).pipe(
                  Effect.andThen(
                    writeFinalRunEvents({
                      run: input.run,
                      rootNode: input.rootNode,
                      checkpointScope: input.checkpointScope,
                      providerThread: input.providerThread,
                      attempt: input.attempt,
                      status: "failed",
                      runtimePolicy: input.runtimePolicy,
                    }),
                  ),
                  Effect.mapError(
                    (writeCause) =>
                      new RunExecutionStartError({
                        commandId: input.commandId,
                        runId: input.run.id,
                        cause: { start: cause, write: writeCause },
                      }),
                  ),
                ),
              ),
            );
        }),
    } satisfies RunExecutionServiceV2Shape);
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
      provider: input.run.provider,
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

function makeInterruptResultTurnItem(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly completedAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-result",
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-request",
    }),
    ordinal: input.run.ordinal * 100 + 98,
    status: "interrupted",
    title: "Interrupted",
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "run_interrupt_result",
    message: "Run interrupted by user",
  };
}
