import {
  CommandId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunAttemptId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
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
import { makeProviderFailure, makeProviderFailureTurnItem } from "./ProviderFailure.ts";

export interface ProviderEventRoutingState {
  readonly ownedThreadIds: ReadonlySet<ThreadId>;
  readonly ownedProviderThreadIds: ReadonlySet<ProviderThreadId>;
  readonly ownedProviderTurnIds: ReadonlySet<ProviderTurnId>;
  readonly rootProviderTurnId: ProviderTurnId | null;
}

export interface ProviderEventRouteIdentity {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
}

type ProviderTerminalEvent = Extract<ProviderAdapterV2Event, { readonly type: "turn.terminal" }>;

function isTerminalProviderTurnStatus(status: OrchestrationV2ProviderTurn["status"]): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function isTerminalSubagentStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

export function finalProviderThreadStatus(
  disposition: ProviderTerminalEvent["threadDisposition"],
): OrchestrationV2ProviderThread["status"] {
  return disposition === "broken" ? "error" : "idle";
}

export function makeProviderEventRoutingState(input: {
  readonly identity: ProviderEventRouteIdentity;
  readonly providerTurnId: ProviderTurnId | null;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
}): ProviderEventRoutingState {
  return {
    ownedThreadIds: new Set([input.identity.threadId, ...(input.relatedThreadIds ?? [])]),
    ownedProviderThreadIds: new Set([
      input.identity.providerThreadId,
      ...(input.relatedProviderThreadIds ?? []),
    ]),
    ownedProviderTurnIds:
      input.providerTurnId === null ? new Set() : new Set([input.providerTurnId]),
    rootProviderTurnId: input.providerTurnId,
  };
}

export function routeProviderEvent(
  event: ProviderAdapterV2Event,
  input: ProviderEventRouteIdentity,
  state: ProviderEventRoutingState,
): readonly [boolean, ProviderEventRoutingState] {
  const ownsThread = (threadId: ThreadId): boolean => state.ownedThreadIds.has(threadId);
  const ownsChildThread = (threadId: ThreadId): boolean =>
    threadId !== input.threadId && ownsThread(threadId);
  const ownsRun = (runId: string | null): boolean => runId === input.runId;
  const addProviderThread = (providerThreadId: ProviderThreadId): ProviderEventRoutingState => ({
    ...state,
    ownedProviderThreadIds: new Set([...state.ownedProviderThreadIds, providerThreadId]),
  });
  const addProviderTurn = (
    providerTurnId: ProviderTurnId,
    root: boolean,
  ): ProviderEventRoutingState => ({
    ...state,
    ownedProviderTurnIds: new Set([...state.ownedProviderTurnIds, providerTurnId]),
    rootProviderTurnId: root ? providerTurnId : state.rootProviderTurnId,
  });

  switch (event.type) {
    case "provider_session.updated":
      // The session manager persists process-wide status once for every
      // attached app thread before broadcasting the adapter event.
      return [false, state];
    case "app_thread.created": {
      if (event.appThread.id === input.threadId) {
        return [true, state];
      }
      const isOwnedSubagent =
        event.appThread.lineage.relationshipToParent === "subagent" &&
        event.appThread.lineage.parentThreadId !== null &&
        ownsThread(event.appThread.lineage.parentThreadId);
      if (!isOwnedSubagent) {
        return [false, state];
      }
      return [
        true,
        {
          ...state,
          ownedThreadIds: new Set([...state.ownedThreadIds, event.appThread.id]),
        },
      ];
    }
    case "provider_thread.updated": {
      const belongs =
        state.ownedProviderThreadIds.has(event.providerThread.id) ||
        (event.providerThread.appThreadId !== null && ownsThread(event.providerThread.appThreadId));
      return belongs ? [true, addProviderThread(event.providerThread.id)] : [false, state];
    }
    case "provider_turn.updated": {
      const isRoot = event.providerTurn.runAttemptId === input.attemptId;
      const belongs =
        isRoot ||
        (event.providerTurn.providerThreadId !== input.providerThreadId &&
          state.ownedProviderThreadIds.has(event.providerTurn.providerThreadId)) ||
        state.ownedProviderTurnIds.has(event.providerTurn.id) ||
        (event.threadId !== undefined && ownsChildThread(event.threadId));
      return belongs ? [true, addProviderTurn(event.providerTurn.id, isRoot)] : [false, state];
    }
    case "node.updated": {
      const belongs = ownsRun(event.node.runId) || ownsChildThread(event.node.threadId);
      if (!belongs || event.node.providerThreadId === null) {
        return [belongs, state];
      }
      return [true, addProviderThread(event.node.providerThreadId)];
    }
    case "subagent.updated":
      return [ownsRun(event.subagent.runId) || ownsChildThread(event.subagent.threadId), state];
    case "message.updated":
      return [ownsRun(event.message.runId) || ownsChildThread(event.message.threadId), state];
    case "turn_item.updated":
      return [ownsRun(event.turnItem.runId) || ownsChildThread(event.turnItem.threadId), state];
    case "plan.updated":
      return [ownsRun(event.plan.runId) || ownsChildThread(event.plan.threadId), state];
    case "runtime_request.updated":
      return [
        (event.threadId !== undefined && ownsChildThread(event.threadId)) ||
          (event.runtimeRequest.providerTurnId !== null &&
            state.ownedProviderTurnIds.has(event.runtimeRequest.providerTurnId)),
        state,
      ];
    case "turn.terminal":
      return [event.providerTurnId === state.rootProviderTurnId, state];
  }
}

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
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
  readonly shouldStartProviderTurn?: () => Effect.Effect<boolean, never>;
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
      readonly terminal: ProviderTerminalEvent;
      readonly failureItemPersisted: boolean;
    }) =>
      Effect.gen(function* () {
        const completedAt = yield* DateTime.now;
        const finalizedAttempt: OrchestrationV2RunAttempt | null = {
          ...input.attempt,
          status: input.terminal.status,
          completedAt,
        };
        const shouldFinalizeRun =
          input.shouldFinalizeRun === undefined ? true : yield* input.shouldFinalizeRun();
        if (!shouldFinalizeRun) {
          // A newer attempt already owns the run and the command that created
          // it terminalized this attempt as superseded. Preserve that domain
          // status while retaining the provider's interruption artifact.
          if (input.terminal.status === "interrupted") {
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
        const persistedStatus =
          input.terminal.status === "completed" ? "waiting" : input.terminal.status;
        const finalizedRun: OrchestrationV2Run = {
          ...input.run,
          status: persistedStatus,
          completedAt: input.terminal.status === "completed" ? null : completedAt,
        };
        const finalizedRootNode: OrchestrationV2ExecutionNode = {
          ...input.rootNode,
          status: persistedStatus,
          completedAt: input.terminal.status === "completed" ? null : completedAt,
          checkpointScopeId: input.checkpointScope.id,
        };
        const finalizedProviderThread: OrchestrationV2ProviderThread = {
          ...input.providerThread,
          status: finalProviderThreadStatus(input.terminal.threadDisposition),
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
            input.terminal.status === "completed"
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
            ...(input.terminal.status === "interrupted"
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
            ...(input.terminal.status === "failed" && !input.failureItemPersisted
              ? [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeProviderFailureTurnItem({
                      idAllocator,
                      driver: input.terminal.driver,
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      providerThreadId: input.terminal.providerThreadId,
                      providerTurnId: input.terminal.providerTurnId,
                      itemOrdinal: input.terminal.failureItemOrdinal,
                      failure: input.terminal.failure,
                      occurredAt: completedAt,
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
          if (
            input.shouldStartProviderTurn !== undefined &&
            !(yield* input.shouldStartProviderTurn())
          ) {
            return;
          }
          const terminalEvent = yield* Ref.make<ProviderTerminalEvent | null>(null);
          const makeFailedTerminalEvent = (
            failure: OrchestrationV2ProviderFailure,
            failureItemOrdinal: number,
          ): ProviderTerminalEvent => ({
            type: "turn.terminal",
            driver: input.providerThread.driver,
            providerThreadId: input.providerThread.id,
            providerTurnId:
              input.attempt.providerTurnId ??
              idAllocator.derive.providerTurn({
                driver: input.providerThread.driver,
                nativeTurnId: `failed:${input.attempt.id}`,
              }),
            runOrdinal: input.run.ordinal,
            failureItemOrdinal,
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
          const latestTurnItemOrdinal = yield* Ref.make(input.providerTurnOrdinal * 100);
          const latestProviderThread = yield* Ref.make(input.providerThread);
          const routeIdentity: ProviderEventRouteIdentity = {
            threadId: input.run.threadId,
            runId: input.run.id,
            attemptId: input.attempt.id,
            providerThreadId: input.providerThread.id,
          };
          const eventRouting = yield* Ref.make<ProviderEventRoutingState>(
            makeProviderEventRoutingState({
              identity: routeIdentity,
              providerTurnId: input.attempt.providerTurnId,
              ...(input.relatedThreadIds === undefined
                ? {}
                : { relatedThreadIds: input.relatedThreadIds }),
              ...(input.relatedProviderThreadIds === undefined
                ? {}
                : { relatedProviderThreadIds: input.relatedProviderThreadIds }),
            }),
          );
          const rootTerminalSeen = yield* Ref.make(false);
          const rootRunFinalized = yield* Ref.make(false);
          const activeChildProviderTurns = yield* Ref.make<ReadonlySet<ProviderTurnId>>(new Set());
          const activeChildSubagents = yield* Ref.make<ReadonlySet<NodeId>>(new Set());
          const finalizeRootRun = (terminal: ProviderTerminalEvent) =>
            Effect.gen(function* () {
              if (yield* Ref.get(rootRunFinalized)) {
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
                terminal,
                failureItemPersisted: terminal.status === "failed",
              }).pipe(
                Effect.mapError(
                  (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
                ),
              );
              yield* Ref.set(rootRunFinalized, true);
            });
          const trackChildLifecycle = (event: ProviderAdapterV2Event) =>
            Effect.gen(function* () {
              const routing = yield* Ref.get(eventRouting);
              if (event.type === "provider_turn.updated") {
                const isRoot =
                  event.providerTurn.runAttemptId === input.attempt.id ||
                  event.providerTurn.id === routing.rootProviderTurnId;
                if (!isRoot) {
                  yield* Ref.update(activeChildProviderTurns, (current) => {
                    const next = new Set(current);
                    if (isTerminalProviderTurnStatus(event.providerTurn.status)) {
                      next.delete(event.providerTurn.id);
                    } else {
                      next.add(event.providerTurn.id);
                    }
                    return next;
                  });
                }
              }
              if (event.type === "subagent.updated") {
                const belongsToRootRun = event.subagent.runId === input.run.id;
                const belongsToOwnedChildThread =
                  event.subagent.threadId !== input.run.threadId &&
                  routing.ownedThreadIds.has(event.subagent.threadId);
                if (belongsToRootRun || belongsToOwnedChildThread) {
                  yield* Ref.update(activeChildSubagents, (current) => {
                    const next = new Set(current);
                    if (isTerminalSubagentStatus(event.subagent.status)) {
                      next.delete(event.subagent.id);
                    } else {
                      next.add(event.subagent.id);
                    }
                    return next;
                  });
                }
              }
            });
          const shouldStopProviderEventIngestion = Effect.gen(function* () {
            if (!(yield* Ref.get(rootTerminalSeen))) {
              return false;
            }
            const childProviderTurns = yield* Ref.get(activeChildProviderTurns);
            if (childProviderTurns.size > 0) {
              return false;
            }
            const childSubagents = yield* Ref.get(activeChildSubagents);
            return childSubagents.size === 0;
          });
          const eventSubscription =
            input.session.subscribeEvents === undefined
              ? { events: input.session.events, close: Effect.void }
              : yield* input.session.subscribeEvents;
          const providerEventFiber = yield* eventSubscription.events.pipe(
            Stream.filterEffect((event) =>
              Ref.modify(eventRouting, (state) => routeProviderEvent(event, routeIdentity, state)),
            ),
            Stream.tap((event) =>
              Effect.gen(function* () {
                let storedEventCount = 0;
                if (shouldDeliverProviderEvent(event, assistantStreamingEnabled)) {
                  const storedEvents = yield* providerEventIngestor.ingestNormalized({
                    providerSessionId: input.providerSessionId,
                    providerInstanceId: input.run.providerInstanceId,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    event,
                    ...(event.type === "provider_thread.updated" &&
                    event.providerThread.id === input.providerThread.id
                      ? {
                          writeIfRunCurrent: {
                            runId: input.run.id,
                            activeAttemptId: input.attempt.id,
                            expectedStatus: "running" as const,
                          },
                        }
                      : {}),
                  });
                  storedEventCount = storedEvents.length;
                }
                if (event.type === "provider_thread.updated") {
                  if (event.providerThread.id === input.providerThread.id && storedEventCount > 0) {
                    yield* Ref.set(latestProviderThread, event.providerThread);
                  }
                }
                if (
                  event.type === "turn_item.updated" &&
                  event.turnItem.providerTurnId ===
                    (yield* Ref.get(eventRouting)).rootProviderTurnId
                ) {
                  yield* Ref.update(latestTurnItemOrdinal, (current) =>
                    Math.max(current, event.turnItem.ordinal),
                  );
                }
                if (event.type === "turn.terminal") {
                  yield* Ref.set(terminalEvent, event);
                  yield* Ref.set(rootTerminalSeen, true);
                  yield* finalizeRootRun(event);
                }
                yield* trackChildLifecycle(event);
              }),
            ),
            Stream.takeUntilEffect(() => shouldStopProviderEventIngestion),
            Stream.runDrain,
            Effect.mapError((cause) => new RunExecutionIngestError({ runId: input.run.id, cause })),
            Effect.flatMap(() =>
              Effect.gen(function* () {
                const terminal = yield* Ref.get(terminalEvent);
                if (terminal === null) {
                  return;
                }
                yield* finalizeRootRun(terminal);
              }),
            ),
            Effect.catchCause((cause) =>
              Ref.get(rootRunFinalized).pipe(
                Effect.flatMap((finalized) =>
                  Effect.logWarning("orchestration V2 provider event ingestion failed", {
                    runId: input.run.id,
                    cause,
                  }).pipe(
                    Effect.andThen(
                      finalized
                        ? Effect.void
                        : Ref.get(latestProviderThread).pipe(
                            Effect.flatMap((providerThread) =>
                              Ref.get(latestTurnItemOrdinal).pipe(
                                Effect.flatMap((latestItemOrdinal) =>
                                  writeFinalRunEvents({
                                    run: input.run,
                                    rootNode: input.rootNode,
                                    checkpointScope: input.checkpointScope,
                                    providerThread,
                                    attempt: input.attempt,
                                    ...(input.shouldFinalizeRun === undefined
                                      ? {}
                                      : { shouldFinalizeRun: input.shouldFinalizeRun }),
                                    terminal: makeFailedTerminalEvent(
                                      makeProviderFailure({
                                        cause: Cause.squash(cause),
                                        class: "unknown",
                                      }),
                                      latestItemOrdinal + 1,
                                    ),
                                    failureItemPersisted: false,
                                  }),
                                ),
                              ),
                            ),
                          ),
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
              ),
            ),
            Effect.ensuring(eventSubscription.close),
            Effect.forkDetach,
          );

          if (
            input.shouldStartProviderTurn !== undefined &&
            !(yield* input.shouldStartProviderTurn())
          ) {
            yield* Fiber.interrupt(providerEventFiber);
            return;
          }

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
                    Ref.get(latestTurnItemOrdinal).pipe(
                      Effect.flatMap((latestItemOrdinal) =>
                        writeFinalRunEvents({
                          run: input.run,
                          rootNode: input.rootNode,
                          checkpointScope: input.checkpointScope,
                          providerThread,
                          attempt: input.attempt,
                          ...(input.shouldFinalizeRun === undefined
                            ? {}
                            : { shouldFinalizeRun: input.shouldFinalizeRun }),
                          terminal: makeFailedTerminalEvent(
                            makeProviderFailure({
                              cause: Cause.squash(cause),
                              class: "provider_error",
                            }),
                            latestItemOrdinal + 1,
                          ),
                          failureItemPersisted: false,
                        }),
                      ),
                    ),
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
