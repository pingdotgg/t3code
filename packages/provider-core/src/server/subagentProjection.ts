import type {
  EventId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2Actor,
  OrchestrationV2ConversationMessage,
  OrchestrationV2CreationSource,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderRef,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";

function trimmed(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result && result.length > 0 ? result : undefined;
}

export function subagentThreadTitle(input: {
  readonly parentTitle: string;
  readonly title?: string | null;
  readonly prompt: string;
  readonly ordinal: number;
}): string {
  const detail = trimmed(input.title) ?? trimmed(input.prompt);
  if (detail === undefined) {
    return `${input.parentTitle} subagent ${input.ordinal}`;
  }
  const clipped = detail.length > 72 ? `${detail.slice(0, 69)}...` : detail;
  return clipped;
}

export function makeSubagentChildThread(input: {
  readonly parentThread: OrchestrationV2AppThread;
  readonly childThreadId: ThreadId;
  readonly parentNodeId: NodeId;
  readonly activeProviderThreadId: ProviderThreadId | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly title: string;
  readonly now: DateTime.Utc;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}): OrchestrationV2AppThread {
  return {
    ...input.parentThread,
    createdBy: input.createdBy,
    creationSource: input.creationSource,
    id: input.childThreadId,
    title: input.title,
    linkedPullRequest: null,
    pullRequests: [],
    historyOrigin: undefined,
    providerInstanceId: input.providerInstanceId,
    modelSelection: input.modelSelection,
    activeProviderThreadId: input.activeProviderThreadId,
    lineage: {
      parentThreadId: input.parentThread.id,
      relationshipToParent: "subagent",
      rootThreadId: input.parentThread.lineage.rootThreadId,
    },
    forkedFrom: {
      type: "node",
      nodeId: input.parentNodeId,
    },
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function makeSubagentConversationArtifacts(input: {
  readonly messageId: MessageId;
  readonly senderThreadId?: ThreadId;
  readonly turnItemId: TurnItemId;
  readonly threadId: ThreadId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId | null;
  readonly providerTurnId: ProviderTurnId | null;
  readonly nativeItemRef: OrchestrationV2ProviderRef | null;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
}): {
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: input.messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: input.rootNodeId,
    role: input.role,
    ...(input.role === "user" && input.senderThreadId !== undefined
      ? { senderThreadId: input.senderThreadId }
      : {}),
    text: input.text,
    attachments: [],
    streaming: false,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const base = {
    id: input.turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: input.rootNodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: input.nativeItemRef,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
    messageId: input.messageId,
    text: input.text,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.role === "user"
      ? {
          ...base,
          createdBy: "agent",
          creationSource: "provider",
          type: "user_message",
          ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
          inputIntent: "turn_start",
          attachments: [],
        }
      : {
          ...base,
          type: "assistant_message",
          streaming: false,
        };
  return { message, turnItem };
}

export function subagentResultForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
  run: OrchestrationV2Run,
): {
  readonly text: string;
  readonly messageId: OrchestrationV2ConversationMessage["id"] | null;
  readonly turnItemId: OrchestrationV2TurnItem["id"] | null;
} {
  const message =
    projection.messages
      .filter(
        (candidate) =>
          candidate.runId === run.id &&
          candidate.role === "assistant" &&
          candidate.text.trim().length > 0,
      )
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null;
  const turnItem =
    projection.turnItems
      .filter(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }> =>
          candidate.runId === run.id &&
          candidate.type === "assistant_message" &&
          candidate.text.trim().length > 0,
      )
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const failure =
    run.status === "failed"
      ? projection.turnItems
          .filter((item) => item.runId === run.id && item.type === "error")
          .toSorted((left, right) => right.ordinal - left.ordinal)[0]
      : undefined;
  const text =
    (failure?.type === "error" ? failure.failure.message : undefined) ??
    message?.text ??
    turnItem?.text ??
    (run.status === "completed"
      ? "Child task completed without an assistant result."
      : `Child task ended with status ${run.status}.`);
  return {
    text,
    messageId: failure === undefined ? (message?.id ?? turnItem?.messageId ?? null) : null,
    turnItemId: failure?.id ?? turnItem?.id ?? null,
  };
}

/** A finished turn can still own live children or queued completion follow-ups. */
export function delegatedTaskProgress(projection: {
  readonly runs: OrchestrationV2ThreadProjection["runs"];
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "runId" | "notification">
  >;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["subagents"][number], "status" | "completionDelivery">
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["providerThreads"][number], "pendingBackgroundTasks">
  >;
}) {
  const terminal = (status: string) =>
    ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
  const monitorRuns = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  const workRuns = projection.runs.filter(
    (run) => !monitorRuns.has(run.id) && run.status !== "rolled_back",
  );
  // A held queue waits for the user to resume it (after Stop, a restart, or a
  // provider failure), so its runs are not work the task still owes.
  const active = workRuns.some(
    (run) => !terminal(run.status) && !(run.status === "queued" && run.queueHeld === true),
  );
  const children =
    projection.subagents.some(
      (task) =>
        isOrchestrationV2WorkActive(task.status) ||
        // Publishing a child's result precedes scheduling its parent's wake.
        // The parent still owes that follow-up even between those transactions.
        task.completionDelivery?.state === "pending" ||
        task.completionDelivery?.state === "claimed",
    ) ||
    projection.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0);
  const resultRun = workRuns
    .filter((run) => terminal(run.status) && (run.startedAt !== null || run.ordinal === 1))
    .toSorted((a, b) => (runRanAfter(a, b) ? -1 : runRanAfter(b, a) ? 1 : 0))[0];
  return {
    state:
      active || resultRun === undefined
        ? ("working" as const)
        : children
          ? ("waiting_for_children" as const)
          : ("result_available" as const),
    resultRun,
  };
}

/** Ids that `emitted` already wrote with an event of `type`. */
function writtenIds(
  emitted: ReadonlyArray<OrchestrationV2DomainEvent>,
  type: "subagent.updated" | "node.updated" | "turn-item.updated",
): ReadonlySet<string> {
  return new Set(emitted.flatMap((event) => (event.type === type ? [event.payload.id] : [])));
}

/**
 * Ends a provider-native subagent, its node and its turn item once the provider
 * process that ran it is gone, since no terminal event will come from it. Each
 * record is skipped if already settled or already ended by `emitted`.
 */
export const endOrphanedNativeSubagent = <E>(input: {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "subagents" | "turnItems">;
  readonly subagentId: NodeId;
  readonly status: "interrupted" | "cancelled";
  readonly now: DateTime.Utc;
  readonly emitted: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}) =>
  Effect.gen(function* () {
    const { now, status, subagentId } = input;
    const subagent = input.projection.subagents.find((entry) => entry.id === subagentId);
    if (subagent?.origin !== "provider_native") return [];
    const node = input.projection.nodes.find((entry) => entry.id === subagentId);
    const item = input.projection.turnItems.find(
      (entry) => entry.type === "subagent" && entry.subagentId === subagentId,
    );
    const scope = {
      threadId: subagent.threadId,
      ...(subagent.runId === null ? {} : { runId: subagent.runId }),
      nodeId: subagentId,
      providerInstanceId: subagent.providerInstanceId,
      occurredAt: now,
    };
    const events: Array<OrchestrationV2DomainEvent> = [];
    if (
      isOrchestrationV2WorkActive(subagent.status) &&
      !writtenIds(input.emitted, "subagent.updated").has(subagentId)
    ) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "subagent.updated",
        driver: subagent.driver,
        payload: { ...subagent, status, completedAt: now, updatedAt: now },
      });
    }
    if (
      node !== undefined &&
      isOrchestrationV2WorkActive(node.status) &&
      !writtenIds(input.emitted, "node.updated").has(subagentId)
    ) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "node.updated",
        payload: { ...node, status, completedAt: now },
      });
    }
    if (
      item !== undefined &&
      isOrchestrationV2WorkActive(item.status) &&
      !writtenIds(input.emitted, "turn-item.updated").has(item.id)
    ) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        payload: { ...item, status, completedAt: now, updatedAt: now },
      });
    }
    return events;
  });

/**
 * Ends a provider-native subagent thread's work, a runless root turn plus the
 * items under it (Claude's live progress), which only the provider process that
 * ran it could settle. Skips records `emitted` already ended.
 */
export const endRunlessRootTurns = <E>(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "turnItems">;
  readonly status: "interrupted" | "cancelled";
  readonly now: DateTime.Utc;
  readonly emitted: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}) =>
  Effect.gen(function* () {
    const { now, status } = input;
    const endedNodeIds = writtenIds(input.emitted, "node.updated");
    const endedItemIds = writtenIds(input.emitted, "turn-item.updated");
    const scope = {
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      occurredAt: now,
    };
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const node of input.projection.nodes) {
      if (
        node.kind !== "root_turn" ||
        node.runId !== null ||
        !isOrchestrationV2WorkActive(node.status)
      ) {
        continue;
      }
      // Recovery may have ended this node through one of its items; its other
      // items still need ending.
      if (!endedNodeIds.has(node.id)) {
        events.push({
          ...scope,
          id: yield* input.allocateEventId(),
          type: "node.updated",
          nodeId: node.id,
          payload: { ...node, status, completedAt: now },
        });
      }
      for (const item of input.projection.turnItems) {
        if (
          item.nodeId !== node.id ||
          item.runId !== null ||
          !isOrchestrationV2WorkActive(item.status) ||
          endedItemIds.has(item.id)
        ) {
          continue;
        }
        events.push({
          ...scope,
          id: yield* input.allocateEventId(),
          type: "turn-item.updated",
          nodeId: node.id,
          payload: {
            ...item,
            status,
            completedAt: now,
            updatedAt: now,
            ...(item.type === "reasoning" || item.type === "assistant_message"
              ? { streaming: false }
              : {}),
          },
        });
      }
    }
    return events;
  });
