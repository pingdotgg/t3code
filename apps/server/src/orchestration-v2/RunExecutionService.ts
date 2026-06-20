import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type RunAttemptId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "./IdAllocator.ts";
import type {
  ProviderAdapterV2Event,
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
    cause: Schema.optional(Schema.Defect()),
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
    cause: Schema.optional(Schema.Defect()),
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
  readonly appThread: OrchestrationV2AppThread;
  readonly providerSessionId: ProviderSessionId;
  readonly session: ProviderAdapterV2SessionRuntime;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly checkpointScope: OrchestrationV2CheckpointScope;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly attemptId: RunAttemptId;
  readonly providerTurnOrdinal: number;
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
>()("t3/orchestration-v2/RunExecutionService/RunExecutionServiceV2") {}

export function shouldDeliverProviderEvent(
  event: ProviderAdapterV2Event,
  assistantStreamingEnabled: boolean,
): boolean {
  if (assistantStreamingEnabled) {
    return true;
  }

  switch (event.type) {
    case "node.updated":
      return event.node.kind !== "assistant_message" || event.node.status !== "running";
    case "message.updated":
      return event.message.role !== "assistant" || !event.message.streaming;
    case "turn_item.updated":
      return event.turnItem.type !== "assistant_message" || !event.turnItem.streaming;
    default:
      return true;
  }
}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<
  RunExecutionServiceV2,
  never,
  | CheckpointServiceV2
  | EventSinkV2
  | IdAllocatorV2
  | ProviderEventIngestorV2
  | ServerSettingsService
> = Layer.effect(
  RunExecutionServiceV2,
  Effect.gen(function* () {
    const checkpointService = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const idAllocator = yield* IdAllocatorV2;
    const providerEventIngestor = yield* ProviderEventIngestorV2;
    const serverSettings = yield* ServerSettingsService;

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
          // A newer attempt already owns the run and the command that created
          // it terminalized this attempt as superseded. Preserve that domain
          // status while retaining the provider's interruption artifact.
          if (input.status === "interrupted") {
            yield* eventSink.write({
              events: [
                {
                  id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                  type: "turn-item.updated" as const,
                  threadId: input.run.threadId,
                  runId: input.run.id,
                  nodeId: input.rootNode.id,
                  providerInstanceId: input.run.providerInstanceId,
                  occurredAt: completedAt,
                  payload: makeInterruptResultTurnItem({
                    idAllocator,
                    run: input.run,
                    rootNode: input.rootNode,
                    providerThread: input.providerThread,
                    completedAt,
                  }),
                },
              ],
            });
          }
          return;
        }
        const persistedStatus = input.status === "completed" ? "waiting" : input.status;
        const finalizedRun: OrchestrationV2Run = {
          ...input.run,
          status: persistedStatus,
          completedAt: input.status === "completed" ? null : completedAt,
        };
        const finalizedRootNode: OrchestrationV2ExecutionNode = {
          ...input.rootNode,
          status: persistedStatus,
          completedAt: input.status === "completed" ? null : completedAt,
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
        const checkpointCaptureCommandId = CommandId.make(
          `command:effect:checkpoint.capture:${input.run.id}`,
        );
        yield* eventSink.writeWithEffects({
          effects:
            input.status === "completed"
              ? [
                  {
                    id: `effect:checkpoint.capture:${input.run.id}`,
                    commandId: checkpointCaptureCommandId,
                    threadId: input.run.threadId,
                    request: {
                      type: "checkpoint.capture" as const,
                      runId: input.run.id,
                      scopeId: input.checkpointScope.id,
                    },
                  },
                ]
              : [],
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
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: finalizedAttempt,
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
                    providerInstanceId: input.run.providerInstanceId,
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
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRun,
            },
            {
              id: nodeEventId,
              type: "node.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRootNode,
            },
            {
              id: providerThreadEventId,
              type: "provider-thread.updated",
              threadId: input.run.threadId,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedProviderThread,
            },
          ],
        });
      });

    return RunExecutionServiceV2.of({
      startRootRun: (input) =>
        Effect.gen(function* () {
          const assistantStreamingEnabled = yield* serverSettings.getSettings.pipe(
            Effect.map((settings) => settings.enableAssistantStreaming),
            Effect.mapError(
              (cause) =>
                new RunExecutionStartError({
                  commandId: input.commandId,
                  runId: input.run.id,
                  cause,
                }),
            ),
          );
          const terminalStatus = yield* Ref.make<Extract<
            OrchestrationV2Run["status"],
            "completed" | "interrupted" | "failed" | "cancelled"
          > | null>(null);
          const latestProviderThread = yield* Ref.make(input.providerThread);
          const providerEventFiber = yield* input.session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (shouldDeliverProviderEvent(event, assistantStreamingEnabled)) {
                  yield* providerEventIngestor.ingestNormalized({
                    providerSessionId: input.providerSessionId,
                    providerInstanceId: input.run.providerInstanceId,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    event,
                  });
                }
                if (event.type === "provider_thread.updated") {
                  if (event.providerThread.id === input.providerThread.id) {
                    yield* Ref.set(latestProviderThread, event.providerThread);
                  }
                }
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
                const providerThread = yield* Ref.get(latestProviderThread);
                yield* writeFinalRunEvents({
                  run: input.run,
                  rootNode: input.rootNode,
                  checkpointScope: input.checkpointScope,
                  providerThread,
                  attempt: input.attempt,
                  ...(input.shouldFinalizeRun === undefined
                    ? {}
                    : { shouldFinalizeRun: input.shouldFinalizeRun }),
                  status,
                }).pipe(
                  Effect.mapError(
                    (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
                  ),
                );
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration V2 provider event ingestion failed", {
                runId: input.run.id,
                cause,
              }).pipe(
                Effect.andThen(Ref.get(latestProviderThread)),
                Effect.flatMap((providerThread) =>
                  writeFinalRunEvents({
                    run: input.run,
                    rootNode: input.rootNode,
                    checkpointScope: input.checkpointScope,
                    providerThread,
                    attempt: input.attempt,
                    ...(input.shouldFinalizeRun === undefined
                      ? {}
                      : { shouldFinalizeRun: input.shouldFinalizeRun }),
                    status: "failed",
                  }),
                ),
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
              appThread: input.appThread,
              threadId: input.run.threadId,
              runId: input.run.id,
              runOrdinal: input.run.ordinal,
              providerTurnOrdinal: input.providerTurnOrdinal,
              attemptId: input.attemptId,
              rootNodeId: input.rootNode.id,
              providerThread: input.providerThread,
              message: input.message,
              modelSelection: input.modelSelection,
              runtimePolicy: input.runtimePolicy,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("orchestration V2 provider turn start failed", {
                  runId: input.run.id,
                  cause,
                }).pipe(
                  Effect.andThen(Fiber.interrupt(providerEventFiber)),
                  Effect.andThen(Ref.get(latestProviderThread)),
                  Effect.flatMap((providerThread) =>
                    writeFinalRunEvents({
                      run: input.run,
                      rootNode: input.rootNode,
                      checkpointScope: input.checkpointScope,
                      providerThread,
                      attempt: input.attempt,
                      ...(input.shouldFinalizeRun === undefined
                        ? {}
                        : { shouldFinalizeRun: input.shouldFinalizeRun }),
                      status: "failed",
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
