import {
  CommandId,
  type EventId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
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
  type TurnItemId,
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
import {
  IdAllocatorV2,
  type IdAllocatorV2AllocationError,
  type IdAllocatorV2Shape,
} from "./IdAllocator.ts";
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

// Turn item types whose lifecycle can outlive the root turn (background
// commands, monitors/dynamic tools, subagent rows). Ingestion must not stop
// while one of these is still non-terminal, or the late completion event is
// dropped and the item spins forever in the projection.
const backgroundCapableTurnItemTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

function isTerminalTurnItemStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;

type OpenRunOwnedSubagentProjection = {
  readonly subagents: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
  readonly turnItems: ReadonlyMap<NodeId, SubagentTurnItem>;
  readonly childTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>;
  readonly nodes: ReadonlyMap<NodeId, OrchestrationV2ExecutionNode>;
  /** Child threads once linked by a root-run subagent row; kept for cascade. */
  readonly linkedChildThreadIds: ReadonlySet<ThreadId>;
};

type RunOwnedSubagentTerminalStatus = Extract<
  OrchestrationV2Subagent["status"],
  "interrupted" | "failed" | "cancelled"
>;

function isOpenExecutionNodeStatus(status: OrchestrationV2ExecutionNode["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isRunOwnedSubagentTerminalStatus(
  status: ProviderTerminalEvent["status"],
): status is RunOwnedSubagentTerminalStatus {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

export function canRouteRelatedSubagent(status: OrchestrationV2Subagent["status"]): boolean {
  return status !== "interrupted" && status !== "failed" && status !== "cancelled";
}

function emptyOpenRunOwnedSubagentProjection(): OpenRunOwnedSubagentProjection {
  return {
    subagents: new Map(),
    turnItems: new Map(),
    childTurnItems: new Map(),
    nodes: new Map(),
    linkedChildThreadIds: new Set(),
  };
}

function withLinkedChildThreadId(
  current: OpenRunOwnedSubagentProjection,
  childThreadId: ThreadId | null,
): OpenRunOwnedSubagentProjection {
  if (childThreadId === null || current.linkedChildThreadIds.has(childThreadId)) {
    return current;
  }
  const linkedChildThreadIds = new Set(current.linkedChildThreadIds);
  linkedChildThreadIds.add(childThreadId);
  return { ...current, linkedChildThreadIds };
}

export function cascadeTerminalizeRunOwnedSubagents(input: {
  readonly run: OrchestrationV2Run;
  readonly open: OpenRunOwnedSubagentProjection;
  readonly status: RunOwnedSubagentTerminalStatus;
  readonly completedAt: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, IdAllocatorV2AllocationError>;
}): Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, IdAllocatorV2AllocationError> {
  return Effect.gen(function* () {
    const events: Array<OrchestrationV2DomainEvent> = [];
    // Prefer lifetime linkage over currently-open rows: subagent/turn-item
    // snapshots may terminalize before the linked child-thread node settles.
    const childThreadIds = new Set(input.open.linkedChildThreadIds);
    for (const item of [...input.open.subagents.values(), ...input.open.turnItems.values()]) {
      if (item.childThreadId !== null) {
        childThreadIds.add(item.childThreadId);
      }
    }
    const keys = new Set<NodeId>([
      ...input.open.subagents.keys(),
      ...input.open.turnItems.keys(),
      ...input.open.nodes.keys(),
    ]);
    for (const key of keys) {
      const subagent = input.open.subagents.get(key);
      if (subagent !== undefined && !isTerminalSubagentStatus(subagent.status)) {
        events.push({
          id: yield* input.allocateEventId(),
          type: "subagent.updated",
          threadId: subagent.threadId,
          runId: input.run.id,
          nodeId: subagent.id,
          driver: subagent.driver,
          providerInstanceId: subagent.providerInstanceId,
          occurredAt: input.completedAt,
          payload: {
            ...subagent,
            status: input.status,
            completedAt: input.completedAt,
            updatedAt: input.completedAt,
          },
        });
      }
      const node = input.open.nodes.get(key);
      if (
        node !== undefined &&
        ((node.threadId === input.run.threadId && node.runId === input.run.id) ||
          childThreadIds.has(node.threadId)) &&
        isOpenExecutionNodeStatus(node.status)
      ) {
        events.push({
          id: yield* input.allocateEventId(),
          type: "node.updated",
          threadId: node.threadId,
          runId: node.runId ?? input.run.id,
          nodeId: node.id,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: input.completedAt,
          payload: {
            ...node,
            status: input.status,
            completedAt: input.completedAt,
          },
        });
      }
      const turnItem = input.open.turnItems.get(key);
      if (
        turnItem !== undefined &&
        turnItem.runId === input.run.id &&
        !isTerminalTurnItemStatus(turnItem.status)
      ) {
        events.push({
          id: yield* input.allocateEventId(),
          type: "turn-item.updated",
          threadId: turnItem.threadId,
          runId: input.run.id,
          ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: input.completedAt,
          payload: {
            ...turnItem,
            status: input.status,
            completedAt: input.completedAt,
            updatedAt: input.completedAt,
          },
        });
      }
    }
    for (const turnItem of input.open.childTurnItems.values()) {
      if (!childThreadIds.has(turnItem.threadId) || isTerminalTurnItemStatus(turnItem.status)) {
        continue;
      }
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: turnItem.threadId,
        runId: turnItem.runId ?? input.run.id,
        ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...turnItem,
          ...("streaming" in turnItem ? { streaming: false } : {}),
          status: input.status,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
    return events;
  });
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
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
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
      readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
      readonly openRunOwnedSubagents?: OpenRunOwnedSubagentProjection;
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
          // Superseded attempt (steer / selection restart). Emit
          // run_interrupt_result only when hard Stop left an unpaired request
          // for this run; plain steers and already-paired stops emit nothing.
          if (input.terminal.status === "interrupted") {
            const hasUnpairedRequest =
              input.hasUnpairedRunInterruptRequest === undefined
                ? false
                : yield* input.hasUnpairedRunInterruptRequest();
            if (hasUnpairedRequest) {
              yield* eventSink.writeWithEffects({
                effects: [],
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
          }
          return;
        }
        const allocateEventId = () => idAllocator.allocate.event({ threadId: input.run.threadId });
        const open = input.openRunOwnedSubagents ?? emptyOpenRunOwnedSubagentProjection();
        const hasOpenSubagentProjection =
          open.subagents.size > 0 ||
          open.turnItems.size > 0 ||
          open.childTurnItems.size > 0 ||
          open.nodes.size > 0;
        const cascadedSubagentEvents =
          isRunOwnedSubagentTerminalStatus(input.terminal.status) && hasOpenSubagentProjection
            ? yield* cascadeTerminalizeRunOwnedSubagents({
                run: input.run,
                open,
                status: input.terminal.status,
                completedAt,
                allocateEventId,
              })
            : [];
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
        const runEventId = yield* allocateEventId();
        const nodeEventId = yield* allocateEventId();
        const providerThreadEventId = yield* allocateEventId();
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
            // Terminalize open run-owned subagent rows before the root run
            // settles so projections never keep a forever-running subagent card.
            ...cascadedSubagentEvents,
            ...(finalizedAttempt === null
              ? []
              : [
                  {
                    id: yield* allocateEventId(),
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
                    id: yield* allocateEventId(),
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
                    id: yield* allocateEventId(),
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
          const activeBackgroundTurnItems = yield* Ref.make<
            ReadonlySet<OrchestrationV2TurnItem["id"]>
          >(new Set());
          const openRunOwnedSubagents = yield* Ref.make(emptyOpenRunOwnedSubagentProjection());
          const finalizeRootRun = (terminal: ProviderTerminalEvent) =>
            Effect.gen(function* () {
              if (yield* Ref.get(rootRunFinalized)) {
                return;
              }
              const providerThread = yield* Ref.get(latestProviderThread);
              const openSubagents = yield* Ref.get(openRunOwnedSubagents);
              yield* writeFinalRunEvents({
                run: input.run,
                rootNode: input.rootNode,
                checkpointScope: input.checkpointScope,
                providerThread,
                attempt: input.attempt,
                ...(input.shouldFinalizeRun === undefined
                  ? {}
                  : { shouldFinalizeRun: input.shouldFinalizeRun }),
                ...(input.hasUnpairedRunInterruptRequest === undefined
                  ? {}
                  : {
                      hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
                    }),
                openRunOwnedSubagents: openSubagents,
                terminal,
                failureItemPersisted: terminal.status === "failed",
              }).pipe(
                Effect.mapError(
                  (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
                ),
              );
              if (isRunOwnedSubagentTerminalStatus(terminal.status)) {
                yield* Ref.set(openRunOwnedSubagents, emptyOpenRunOwnedSubagentProjection());
              }
              yield* Ref.set(rootRunFinalized, true);
            });
          const trackChildLifecycle = (event: ProviderAdapterV2Event, deliverable: boolean) =>
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
                // Snapshot run-owned subagents for interrupt cascade.
                // Preserve childThreadId linkage for the root-run lifetime even
                // after the subagent row terminalizes, so open child-thread
                // nodes can still be proven linked on a later root interrupt.
                if (belongsToRootRun) {
                  yield* Ref.update(openRunOwnedSubagents, (current) => {
                    const withLink = withLinkedChildThreadId(current, event.subagent.childThreadId);
                    const subagents = new Map(withLink.subagents);
                    if (isTerminalSubagentStatus(event.subagent.status)) {
                      subagents.delete(event.subagent.id);
                    } else {
                      subagents.set(event.subagent.id, event.subagent);
                    }
                    return { ...withLink, subagents };
                  });
                }
              }
              if (event.type === "node.updated") {
                const belongsToRootSubagent =
                  event.node.kind === "subagent" && event.node.runId === input.run.id;
                const belongsToOwnedChildThread =
                  event.node.threadId !== input.run.threadId &&
                  routing.ownedThreadIds.has(event.node.threadId);
                if (!belongsToRootSubagent && !belongsToOwnedChildThread) {
                  return;
                }
                yield* Ref.update(openRunOwnedSubagents, (current) => {
                  const nodes = new Map(current.nodes);
                  if (isOpenExecutionNodeStatus(event.node.status)) {
                    nodes.set(event.node.id, event.node);
                  } else {
                    nodes.delete(event.node.id);
                  }
                  return { ...current, nodes };
                });
              }
              if (event.type === "turn_item.updated") {
                const belongsToRootRun = event.turnItem.runId === input.run.id;
                const belongsToOwnedChildThread =
                  event.turnItem.threadId !== input.run.threadId &&
                  routing.ownedThreadIds.has(event.turnItem.threadId);
                if (
                  backgroundCapableTurnItemTypes.has(event.turnItem.type) &&
                  (belongsToRootRun || belongsToOwnedChildThread)
                ) {
                  yield* Ref.update(activeBackgroundTurnItems, (current) => {
                    const next = new Set(current);
                    if (isTerminalTurnItemStatus(event.turnItem.status)) {
                      next.delete(event.turnItem.id);
                    } else {
                      next.add(event.turnItem.id);
                    }
                    return next;
                  });
                }
                if (belongsToOwnedChildThread && deliverable) {
                  yield* Ref.update(openRunOwnedSubagents, (current) => {
                    const childTurnItems = new Map(current.childTurnItems);
                    if (isTerminalTurnItemStatus(event.turnItem.status)) {
                      childTurnItems.delete(event.turnItem.id);
                    } else {
                      childTurnItems.set(event.turnItem.id, event.turnItem);
                    }
                    return { ...current, childTurnItems };
                  });
                }
                if (belongsToRootRun && event.turnItem.type === "subagent") {
                  const subagentItem = event.turnItem;
                  yield* Ref.update(openRunOwnedSubagents, (current) => {
                    const withLink = withLinkedChildThreadId(current, subagentItem.childThreadId);
                    const turnItems = new Map(withLink.turnItems);
                    if (isTerminalTurnItemStatus(subagentItem.status)) {
                      turnItems.delete(subagentItem.subagentId);
                    } else {
                      turnItems.set(subagentItem.subagentId, subagentItem);
                    }
                    return { ...withLink, turnItems };
                  });
                }
              }
            });
          const shouldStopProviderEventIngestion = Effect.gen(function* () {
            if (!(yield* Ref.get(rootTerminalSeen))) {
              return false;
            }
            const terminal = yield* Ref.get(terminalEvent);
            if (terminal !== null && terminal.status !== "completed") {
              return true;
            }
            const childProviderTurns = yield* Ref.get(activeChildProviderTurns);
            if (childProviderTurns.size > 0) {
              return false;
            }
            const childSubagents = yield* Ref.get(activeChildSubagents);
            if (childSubagents.size > 0) {
              return false;
            }
            // Keep ingesting past root settlement while background-capable
            // items owned by this run (or an owned child thread) are still
            // non-terminal, so their late completion events reach the
            // projection (stuck-spinner fix). Only for completed runs:
            // interrupted/failed turns intentionally drop background tracking
            // rather than pinning the stream open. Assumes adapters emit an
            // item's non-terminal event before the root terminal; an item
            // first seen after the terminal is not pinned.
            const backgroundItems = yield* Ref.get(activeBackgroundTurnItems);
            return backgroundItems.size === 0;
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
                const shouldDeliver = shouldDeliverProviderEvent(event, assistantStreamingEnabled);
                if (shouldDeliver) {
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
                yield* trackChildLifecycle(event, shouldDeliver);
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
                                  Ref.get(openRunOwnedSubagents).pipe(
                                    Effect.flatMap((openSubagents) =>
                                      writeFinalRunEvents({
                                        run: input.run,
                                        rootNode: input.rootNode,
                                        checkpointScope: input.checkpointScope,
                                        providerThread,
                                        attempt: input.attempt,
                                        ...(input.shouldFinalizeRun === undefined
                                          ? {}
                                          : { shouldFinalizeRun: input.shouldFinalizeRun }),
                                        ...(input.hasUnpairedRunInterruptRequest === undefined
                                          ? {}
                                          : {
                                              hasUnpairedRunInterruptRequest:
                                                input.hasUnpairedRunInterruptRequest,
                                            }),
                                        openRunOwnedSubagents: openSubagents,
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
                        Ref.get(openRunOwnedSubagents).pipe(
                          Effect.flatMap((openSubagents) =>
                            writeFinalRunEvents({
                              run: input.run,
                              rootNode: input.rootNode,
                              checkpointScope: input.checkpointScope,
                              providerThread,
                              attempt: input.attempt,
                              ...(input.shouldFinalizeRun === undefined
                                ? {}
                                : { shouldFinalizeRun: input.shouldFinalizeRun }),
                              ...(input.hasUnpairedRunInterruptRequest === undefined
                                ? {}
                                : {
                                    hasUnpairedRunInterruptRequest:
                                      input.hasUnpairedRunInterruptRequest,
                                  }),
                              openRunOwnedSubagents: openSubagents,
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
