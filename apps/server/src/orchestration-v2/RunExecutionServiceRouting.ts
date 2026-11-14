import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isOrchestrationV2WorkActive,
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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import { userFacingDatabaseErrorMessage } from "./UserFacingErrors.ts";

export interface ProviderEventRoutingState {
  readonly ownedThreadIds: ReadonlySet<ThreadId>;
  // After root settlement, new children belong to the live run unless their coordinator still holds this run open.
  readonly rootTurnEnded: boolean;
  readonly workflowMemberParents: ReadonlyMap<ThreadId, ThreadId>;
  readonly ownedProviderThreadIds: ReadonlySet<ProviderThreadId>;
  readonly ownedProviderTurns: ReadonlyMap<ProviderTurnId, ProviderThreadId>;
  readonly inheritedBackgroundTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2Run["id"]>;
  readonly rootProviderTurnId: ProviderTurnId | null;
}

export interface ProviderEventRouteIdentity {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
}

export interface InheritedBackgroundTurnItemRoute {
  readonly id: TurnItemId;
  readonly runId: OrchestrationV2Run["id"];
}

export type ProviderTerminalEvent = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { readonly type: "turn.terminal" }
>;

export function isTerminalProviderTurnStatus(status: OrchestrationV2ProviderTurn["status"]): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

export function isSettledSubagentStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

/** A provider-native subagent's turns arrive on its parent's run, but the parent agent started them. */
export const NATIVE_SUBAGENT_TURN_ORIGIN: ProviderUsageAnalytics.ProviderTurnOrigin = {
  createdBy: "agent",
  creationSource: "provider",
  scheduled: false,
  subagent: true,
};

export const backgroundCapableTurnItemTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

export function isSettledTurnItemStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

export function isSettledRunEligibleForInheritedBackground(status: OrchestrationV2Run["status"]): boolean {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

/** Use durable provider-thread lineage; sessions can host multiple threads. */
export function selectInheritedBackgroundTurnItems(input: {
  readonly threadId: ThreadId;
  readonly currentProviderThreadId: ProviderThreadId;
  readonly currentRunOrdinal: number;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): ReadonlyArray<InheritedBackgroundTurnItemRoute> {
  const settledPriorRunIds = new Set(
    input.runs
      .filter(
        (run) =>
          run.threadId === input.threadId &&
          run.ordinal < input.currentRunOrdinal &&
          isSettledRunEligibleForInheritedBackground(run.status),
      )
      .map((run) => run.id),
  );
  return input.turnItems.flatMap((turnItem) =>
    turnItem.threadId === input.threadId &&
    turnItem.providerThreadId === input.currentProviderThreadId &&
    turnItem.runId !== null &&
    settledPriorRunIds.has(turnItem.runId) &&
    backgroundCapableTurnItemTypes.has(turnItem.type) &&
    !isSettledTurnItemStatus(turnItem.status)
      ? [{ id: turnItem.id, runId: turnItem.runId }]
      : [],
  );
}

export type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;

export type OpenRunOwnedSubagentProjection = {
  readonly subagents: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
  readonly turnItems: ReadonlyMap<NodeId, SubagentTurnItem>;
  readonly childTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>;
  readonly nodes: ReadonlyMap<NodeId, OrchestrationV2ExecutionNode>;
  readonly linkedChildThreadIds: ReadonlySet<ThreadId>;
};

export type RunOwnedSubagentTerminalStatus = Extract<
  OrchestrationV2Subagent["status"],
  "interrupted" | "failed" | "cancelled"
>;

export function isOpenExecutionNodeStatus(status: OrchestrationV2ExecutionNode["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

export function isRunOwnedSubagentTerminalStatus(
  status: ProviderTerminalEvent["status"],
): status is RunOwnedSubagentTerminalStatus {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

export function childTurnsContinue(terminal: ProviderTerminalEvent): boolean {
  return terminal.status === "failed" && terminal.childTurnsContinue === true;
}

/** Launching runs still ingest running subagents; taking them over would duplicate events. */
export function canRouteRelatedSubagent(status: OrchestrationV2Subagent["status"]): boolean {
  return status === "completed";
}

export function emptyOpenRunOwnedSubagentProjection(): OpenRunOwnedSubagentProjection {
  return {
    subagents: new Map(),
    turnItems: new Map(),
    childTurnItems: new Map(),
    nodes: new Map(),
    linkedChildThreadIds: new Set(),
  };
}

export function withLinkedChildThreadId(
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

export const cascadeTerminalizeRunOwnedSubagents = Effect.fn(
  "RunExecutionService.cascadeTerminalizeRunOwnedSubagents",
)(function* (input: {
  readonly run: OrchestrationV2Run;
  readonly open: OpenRunOwnedSubagentProjection;
  readonly status: RunOwnedSubagentTerminalStatus;
  readonly completedAt: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, IdAllocator.IdAllocatorV2AllocationError>;
}): Effect.fn.Return<
  ReadonlyArray<OrchestrationV2DomainEvent>,
  IdAllocator.IdAllocatorV2AllocationError
> {
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
    if (subagent !== undefined && !isSettledSubagentStatus(subagent.status)) {
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
      !isSettledTurnItemStatus(turnItem.status)
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
    if (!childThreadIds.has(turnItem.threadId) || isSettledTurnItemStatus(turnItem.status)) {
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

export function finalProviderThreadStatus(
  disposition: ProviderTerminalEvent["threadDisposition"],
): OrchestrationV2ProviderThread["status"] {
  return disposition === "broken" ? "error" : "idle";
}

export function makeProviderEventRoutingState(input: {
  readonly identity: ProviderEventRouteIdentity;
  readonly inheritedBackgroundTurnItems?: ReadonlyArray<InheritedBackgroundTurnItemRoute>;
  readonly providerTurnId: ProviderTurnId | null;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
}): ProviderEventRoutingState {
  return {
    ownedThreadIds: new Set([input.identity.threadId, ...(input.relatedThreadIds ?? [])]),
    rootTurnEnded: false,
    workflowMemberParents: new Map(),
    ownedProviderThreadIds: new Set([
      input.identity.providerThreadId,
      ...(input.relatedProviderThreadIds ?? []),
    ]),
    ownedProviderTurns:
      input.providerTurnId === null
        ? new Map()
        : new Map([[input.providerTurnId, input.identity.providerThreadId]]),
    inheritedBackgroundTurnItems: new Map(
      (input.inheritedBackgroundTurnItems ?? []).map((item) => [item.id, item.runId]),
    ),
    rootProviderTurnId: input.providerTurnId,
  };
}

export function routeProviderEvent(
  event: ProviderAdapter.ProviderAdapterV2Event,
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
    providerThreadId: ProviderThreadId,
    root: boolean,
  ): ProviderEventRoutingState => ({
    ...state,
    ownedProviderTurns: new Map(state.ownedProviderTurns).set(providerTurnId, providerThreadId),
    rootProviderTurnId: root ? providerTurnId : state.rootProviderTurnId,
  });

  switch (event.type) {
    case "provider_session.updated":
      return [false, state];
    case "app_thread.created": {
      if (event.appThread.id === input.threadId) {
        return [true, state];
      }
      const isOwnedSubagent =
        event.appThread.lineage.relationshipToParent === "subagent" &&
        event.appThread.lineage.parentThreadId !== null &&
        ownsThread(event.appThread.lineage.parentThreadId) &&
        (!state.rootTurnEnded ||
          state.workflowMemberParents.get(event.appThread.id) ===
            event.appThread.lineage.parentThreadId);
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
        state.ownedProviderTurns.has(event.providerTurn.id) ||
        (event.threadId !== undefined && ownsChildThread(event.threadId));
      return belongs
        ? [
            true,
            addProviderTurn(event.providerTurn.id, event.providerTurn.providerThreadId, isRoot),
          ]
        : [false, state];
    }
    case "node.updated": {
      const belongs = ownsRun(event.node.runId) || ownsChildThread(event.node.threadId);
      if (!belongs || event.node.providerThreadId === null) {
        return [belongs, state];
      }
      return [true, addProviderThread(event.node.providerThreadId)];
    }
    case "subagent.updated": {
      const moved = event.subagent;
      if (
        moved.origin === "provider_native" &&
        moved.threadId === input.threadId &&
        moved.runId !== null &&
        !ownsRun(moved.runId) &&
        moved.childThreadId !== null &&
        ownsChildThread(moved.childThreadId)
      ) {
        const ownedThreadIds = new Set(state.ownedThreadIds);
        ownedThreadIds.delete(moved.childThreadId);
        const ownedProviderThreadIds = new Set(state.ownedProviderThreadIds);
        if (moved.providerThreadId !== null) ownedProviderThreadIds.delete(moved.providerThreadId);
        const ownedProviderTurns = new Map(state.ownedProviderTurns);
        for (const [turnId, threadId] of ownedProviderTurns) {
          if (threadId === moved.providerThreadId) ownedProviderTurns.delete(turnId);
        }
        return [false, { ...state, ownedThreadIds, ownedProviderThreadIds, ownedProviderTurns }];
      }
      const belongs = ownsRun(event.subagent.runId) || ownsChildThread(event.subagent.threadId);
      const coordinator = event.subagent;
      // Resumes reattribute child threads to the live run, which may not have observed their creation.
      const adopted =
        ownsRun(coordinator.runId) &&
        !state.rootTurnEnded &&
        isOrchestrationV2WorkActive(coordinator.status) &&
        coordinator.origin === "provider_native" &&
        coordinator.childThreadId !== null &&
        !ownsThread(coordinator.childThreadId)
          ? {
              ...state,
              ownedThreadIds: new Set([...state.ownedThreadIds, coordinator.childThreadId]),
            }
          : state;
      if (
        !ownsRun(coordinator.runId) ||
        coordinator.workflow === undefined ||
        coordinator.childThreadId === null
      ) {
        return [belongs, adopted];
      }
      const workflowMemberParents = new Map(state.workflowMemberParents);
      for (const member of coordinator.workflow.agents) {
        if (member.childThreadId !== undefined) {
          workflowMemberParents.set(member.childThreadId, coordinator.childThreadId);
        }
      }
      return [true, { ...adopted, workflowMemberParents }];
    }
    case "message.updated":
      return [ownsRun(event.message.runId) || ownsChildThread(event.message.threadId), state];
    case "turn_item.updated": {
      if (ownsRun(event.turnItem.runId) || ownsChildThread(event.turnItem.threadId)) {
        return [true, state];
      }
      const inheritedRunId = state.inheritedBackgroundTurnItems.get(event.turnItem.id);
      const isInheritedBackgroundItem =
        event.turnItem.threadId === input.threadId &&
        event.turnItem.runId !== null &&
        event.turnItem.runId === inheritedRunId &&
        backgroundCapableTurnItemTypes.has(event.turnItem.type);
      if (!isInheritedBackgroundItem) {
        return [false, state];
      }
      if (!isSettledTurnItemStatus(event.turnItem.status)) {
        return [true, state];
      }
      const inheritedBackgroundTurnItems = new Map(state.inheritedBackgroundTurnItems);
      inheritedBackgroundTurnItems.delete(event.turnItem.id);
      return [true, { ...state, inheritedBackgroundTurnItems }];
    }
    case "plan.updated":
      return [ownsRun(event.plan.runId) || ownsChildThread(event.plan.threadId), state];
    case "runtime_request.updated":
      return [
        (event.threadId !== undefined && ownsChildThread(event.threadId)) ||
          (event.runtimeRequest.providerTurnId !== null &&
            state.ownedProviderTurns.has(event.runtimeRequest.providerTurnId)),
        state,
      ];
    case "background_work.updated":
      return [state.ownedProviderTurns.has(event.providerTurnId), state];
    case "command_output.delta":
      // The session manager hands live output to the command output hub; runs never see it.
      return [false, state];
    case "turn.terminal":
      return event.providerTurnId === state.rootProviderTurnId
        ? [true, { ...state, rootTurnEnded: true }]
        : [false, state];
  }
}

export class RunExecutionStartError extends Schema.TaggedError<RunExecutionStartError>()(
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

export class RunExecutionIngestError extends Schema.TaggedError<RunExecutionIngestError>()(
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
