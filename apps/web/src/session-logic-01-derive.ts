import { STANDALONE_V2_ITEM_TYPES, projectedItemCreatedAt, projectedWorkEntry } from "./session-logic-02-work.ts";
import type { AttachmentResource, TimelineAttempt, TimelineEntriesInput, TimelineEntriesProjection, TimelineEntry } from "./session-logic-02-work.ts";
import type { ThreadStructure, ThreadStructureRuntime } from "@t3tools/client-runtime/state/shell";
import {
  type AssetResource,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type PlanId,
  type RunId,
  type ToolActivitySurface,
  type ToolActivityIcon,
  type ToolActivitySource,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { htmlRenderFromToolItem, mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { threadRuntimeHasInterruptibleRun } from "@t3tools/client-runtime/state/thread-execution";
import { turnItemIsWorkspacePreparation } from "@t3tools/client-runtime/state/turn-item-presentation";
import {
  isImageAttachment,
  type ChatAttachment,
  type ChatMessage,
  type ProposedPlan,
  type SessionPhase,
  type TurnDiffSummary,
} from "./types";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import { shallow } from "zustand/vanilla/shallow";
export { formatDuration } from "@t3tools/shared/orchestrationTiming";
export {
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolFailure,
} from "@t3tools/client-runtime/work-log/presentation";

export function deriveTimelineEntriesFromVisibleTurnItems(
  input: TimelineEntriesInput,
): TimelineEntry[] {
  const committedMessageIds = new Set<string>();
  const entries: TimelineEntry[] = [];
  const attemptByRootNodeId = new Map(
    (input.attempts ?? []).map((attempt) => [attempt.rootNodeId, attempt] as const),
  );
  const nodeById = new Map((input.nodes ?? []).map((node) => [node.id, node] as const));
  const planById = new Map((input.plans ?? []).map((plan) => [plan.id, plan] as const));

  const resolveAttempt = (item: OrchestrationV2TurnItem): TimelineAttempt | undefined => {
    if (item.nodeId === null || item.runId === null) return undefined;
    let nodeId: OrchestrationV2ExecutionNode["id"] | null = item.nodeId;
    const visited = new Set<OrchestrationV2ExecutionNode["id"]>();
    while (nodeId !== null && !visited.has(nodeId)) {
      visited.add(nodeId);
      const directAttempt = attemptByRootNodeId.get(nodeId);
      if (directAttempt?.runId === item.runId) return directAttempt;
      const node = nodeById.get(nodeId);
      if (node === undefined) return undefined;
      const rootAttempt = attemptByRootNodeId.get(node.rootNodeId);
      if (rootAttempt?.runId === item.runId) return rootAttempt;
      nodeId = node.parentNodeId;
    }
    return undefined;
  };

  const foldedAnswerMessageIds = new Set(
    input.visibleTurnItems.flatMap(({ item }) =>
      item.type === "user_input_request" && item.questionAnswer
        ? [`async-answer:${item.questionAnswer.requestId}`]
        : [],
    ),
  );
  for (const row of input.visibleTurnItems) {
    const { item } = row;
    if (turnItemIsWorkspacePreparation(item) && !item.deferredWork) continue;
    if (item.type === "checkpoint") continue;
    if (
      item.type === "user_message" &&
      item.inputIntent === "queued_turn" &&
      item.status === "pending"
    )
      continue;
    if (item.type === "user_message" && foldedAnswerMessageIds.has(item.messageId)) continue;
    const createdAt = projectedItemCreatedAt(row);
    const attempt = resolveAttempt(item);
    const attemptMetadata = attempt === undefined ? {} : { attempt };
    if (item.type === "notification") {
      entries.push({
        id: item.id,
        kind: "work",
        createdAt,
        entry: {
          id: item.id,
          createdAt,
          runId: item.runId,
          label: item.summary,
          tone: "info",
          itemType: item.type,
          structuredPayload: item,
          projectedItem: row,
        },
        ...attemptMetadata,
      });
      continue;
    }
    if (item.type === "user_message" || item.type === "assistant_message") {
      const message: ChatMessage = {
        id: item.messageId,
        role: item.type === "user_message" ? "user" : "assistant",
        text: item.text,
        ...(item.type === "user_message" && item.context ? { context: item.context } : {}),
        ...((item.attachments?.length ?? 0) > 0
          ? {
              attachments: (item.attachments ?? []).map((attachment) => {
                const previewUrl = input.attachmentUrlById?.get(attachment.id);
                return previewUrl ? { ...attachment, previewUrl } : attachment;
              }),
            }
          : {}),
        runId: item.runId,
        streaming: item.type === "assistant_message" && item.streaming,
        ...(item.type === "user_message"
          ? {
              createdBy: item.createdBy,
              creationSource: item.creationSource,
              ...(item.senderThreadId !== undefined ? { senderThreadId: item.senderThreadId } : {}),
              ...(item.idleCompaction !== undefined ? { idleCompaction: item.idleCompaction } : {}),
              ...(item.scheduledTaskId !== undefined
                ? { scheduledTaskId: item.scheduledTaskId }
                : {}),
            }
          : {}),
        createdAt,
        updatedAt: DateTime.formatIso(item.updatedAt),
        ...(item.type === "user_message" ? { inputIntent: item.inputIntent } : {}),
      };
      committedMessageIds.add(message.id);
      entries.push({
        id: message.id,
        kind: "message",
        createdAt,
        message,
        projectedItem: row,
        ...attemptMetadata,
      });
      continue;
    }

    if (item.type === "proposed_plan") {
      const plan = planById.get(item.planId);
      const proposedPlan = {
        id: item.planId,
        runId: item.runId,
        planMarkdown: item.markdown,
        status: plan?.kind === "proposed_plan" ? plan.status : ("active" as const),
        createdAt,
        updatedAt: DateTime.formatIso(item.updatedAt),
      };
      entries.push({
        id: item.id,
        kind: "proposed-plan",
        createdAt,
        proposedPlan,
        ...attemptMetadata,
      });
      continue;
    }

    const htmlRender =
      item.type === "dynamic_tool" && item.status === "completed"
        ? htmlRenderFromToolItem(item)
        : undefined;
    if (htmlRender !== undefined) {
      entries.push({
        id: item.id,
        kind: "html-render",
        createdAt,
        runId: item.runId,
        htmlRender,
        ...attemptMetadata,
      });
      continue;
    }

    const mcpApp = item.type === "dynamic_tool" ? mcpAppFromToolItem(item) : undefined;
    if (mcpApp !== undefined) {
      entries.push({
        id: item.id,
        kind: "mcp-app",
        createdAt,
        runId: item.runId,
        sourceThreadId: row.sourceThreadId,
        itemId: row.sourceItemId,
        revision: turnItemDetailRevision(item),
        mcpApp,
        ...attemptMetadata,
      });
      continue;
    }

    if (STANDALONE_V2_ITEM_TYPES.has(item.type)) {
      entries.push({
        id: item.id,
        kind: "event",
        createdAt,
        projectedItem: row,
        ...attemptMetadata,
      });
      continue;
    }

    entries.push({
      id: item.id,
      kind: "work",
      createdAt,
      entry: projectedWorkEntry(row),
      ...attemptMetadata,
    });
  }

  const retainedMessageIds = new Set([...committedMessageIds, ...foldedAnswerMessageIds]);
  for (const message of input.anchoredMessages ?? []) {
    if (retainedMessageIds.has(message.id)) continue;
    retainedMessageIds.add(message.id);
    const entry: TimelineEntry = {
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    };
    const insertionIndex = entries.findIndex(
      (candidate) => candidate.createdAt > message.createdAt,
    );
    if (insertionIndex === -1) {
      entries.push(entry);
    } else {
      entries.splice(insertionIndex, 0, entry);
    }
  }

  for (const message of input.optimisticMessages) {
    if (message.inputIntent !== "queued_turn" && !retainedMessageIds.has(message.id)) {
      retainedMessageIds.add(message.id);
      entries.push({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      });
    }
  }

  return entries;
}

export const EMPTY_IMAGE_RESOURCES = Object.freeze<ReadonlyArray<AttachmentResource>>([]);

export function selectMessageImageResources(
  attachments: ChatMessage["attachments"],
): ReadonlyArray<AttachmentResource> {
  const attachmentIds = new Set<string>();
  for (const attachment of attachments ?? []) {
    if (!isImageAttachment(attachment)) continue;
    const previewUrl = attachment.previewUrl;
    if (previewUrl?.startsWith("blob:") || previewUrl?.startsWith("data:")) continue;
    attachmentIds.add(attachment.id);
  }
  return attachmentIds.size === 0
    ? EMPTY_IMAGE_RESOURCES
    : Array.from(attachmentIds, (attachmentId) => ({ _tag: "attachment", attachmentId }));
}

export function selectHandoffImageResources(
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "attachments">> | undefined,
  handoffs: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<AttachmentResource> {
  if (Object.keys(handoffs).length === 0) return EMPTY_IMAGE_RESOURCES;
  const attachmentIds = new Set<string>();
  for (const message of messages ?? []) {
    if (message.role !== "user" || !handoffs[message.id]?.length) continue;
    for (const attachment of message.attachments ?? []) {
      if (isImageAttachment(attachment)) attachmentIds.add(attachment.id);
    }
  }
  return attachmentIds.size === 0
    ? EMPTY_IMAGE_RESOURCES
    : Array.from(attachmentIds, (attachmentId) => ({ _tag: "attachment", attachmentId }));
}

export function createMessageAttachmentPreviewProjector() {
  const attachmentsBySource = new WeakMap<
    ReadonlyArray<ChatAttachment>,
    ReadonlyArray<ChatAttachment>
  >();
  const messagesBySource = new WeakMap<ChatMessage, ChatMessage>();
  return (
    message: ChatMessage,
    previewUrlFor: (attachment: ChatAttachment) => string | undefined,
  ): ChatMessage => {
    const source = message.attachments;
    if (!source || source.length === 0) return message;
    const previous = attachmentsBySource.get(source) ?? source;
    let changed: ChatAttachment[] | undefined;
    let hasOverrides = false;
    for (const [index, attachment] of source.entries()) {
      const previewUrl = previewUrlFor(attachment);
      const sourceUrl = "previewUrl" in attachment ? attachment.previewUrl : undefined;
      const previousAttachment = previous[index]!;
      const previousUrl =
        "previewUrl" in previousAttachment ? previousAttachment.previewUrl : undefined;
      const next =
        !previewUrl || previewUrl === sourceUrl
          ? attachment
          : previewUrl === previousUrl
            ? previousAttachment
            : { ...attachment, previewUrl };
      hasOverrides ||= next !== attachment;
      if (next !== previousAttachment) {
        changed ??= previous.slice();
        changed[index] = next;
      }
    }
    const attachments = hasOverrides ? (changed ?? previous) : source;
    attachmentsBySource.set(source, attachments);
    if (attachments === source) {
      messagesBySource.delete(message);
      return message;
    }
    const previousMessage = messagesBySource.get(message);
    if (previousMessage?.attachments === attachments) return previousMessage;
    const result = { ...message, attachments };
    messagesBySource.set(message, result);
    return result;
  };
}

export function isStreamingMessageTextUpdate(previous: ChatMessage, next: ChatMessage): boolean {
  if (
    previous.role !== "assistant" ||
    next.role !== "assistant" ||
    !previous.streaming ||
    !next.streaming
  ) {
    return false;
  }
  const { text: _previousText, updatedAt: _previousUpdatedAt, ...previousMetadata } = previous;
  const { text: _nextText, updatedAt: _nextUpdatedAt, ...nextMetadata } = next;
  return shallow(previousMetadata, nextMetadata);
}

export function isStreamingTurnItemTextUpdate(
  previous: OrchestrationV2ProjectedTurnItem,
  next: OrchestrationV2ProjectedTurnItem,
): boolean {
  const { item: previousItem, ...previousSource } = previous;
  const { item: nextItem, ...nextSource } = next;
  if (
    previousItem.type !== "assistant_message" ||
    nextItem.type !== "assistant_message" ||
    !previousItem.streaming ||
    !nextItem.streaming ||
    !shallow(previousSource, nextSource) ||
    projectedItemCreatedAt(previous) !== projectedItemCreatedAt(next)
  ) {
    return false;
  }
  const { text: _previousText, updatedAt: _previousUpdatedAt, ...previousMetadata } = previousItem;
  const { text: _nextText, updatedAt: _nextUpdatedAt, ...nextMetadata } = nextItem;
  // Wire decoding recreates timestamps and attachments; compare only the changed item's metadata.
  return Equal.equals(previousMetadata, nextMetadata);
}

/**
 * A changed tool or work item maps to exactly one entry with the item's id.
 * Messages and question answers take part in cross-entry dedupe, and anchored
 * messages are placed by createdAt, so those changes rebuild.
 */
export function canRederiveInPlace(
  input: TimelineEntriesInput,
  previousItem: OrchestrationV2ProjectedTurnItem,
  item: OrchestrationV2ProjectedTurnItem,
): boolean {
  return (
    item.item.id === previousItem.item.id &&
    item.item.type === previousItem.item.type &&
    item.item.type !== "user_message" &&
    item.item.type !== "assistant_message" &&
    item.item.type !== "user_input_request" &&
    ((input.anchoredMessages?.length ?? 0) === 0 ||
      projectedItemCreatedAt(item) === projectedItemCreatedAt(previousItem))
  );
}

export function reuseTimelineEntries(
  input: TimelineEntriesInput,
  previous: TimelineEntriesProjection,
): TimelineEntry[] | null {
  const before = previous.input;
  if (
    input.visibleTurnItems.length < before.visibleTurnItems.length ||
    !shallow(input.optimisticMessages, before.optimisticMessages) ||
    !shallow(input.anchoredMessages, before.anchoredMessages) ||
    !shallow(input.attachmentUrlById, before.attachmentUrlById) ||
    !shallow(input.attempts, before.attempts) ||
    !shallow(input.nodes, before.nodes) ||
    !shallow(input.plans, before.plans)
  ) {
    return null;
  }
  const appended = input.visibleTurnItems.length > before.visibleTurnItems.length;
  // Keep full projection until committed items interleave and deduplicate anchored/optimistic messages.
  if (
    appended &&
    (input.optimisticMessages.length > 0 || (input.anchoredMessages?.length ?? 0) > 0)
  ) {
    return null;
  }
  // Answer rows can replace a message already present in the retained prefix.
  if (
    appended &&
    input.visibleTurnItems
      .slice(before.visibleTurnItems.length)
      .some(
        ({ item }) =>
          (item.type === "user_input_request" && item.questionAnswer !== undefined) ||
          (item.type === "user_message" && item.messageId.startsWith("async-answer:")),
      )
  )
    return null;
  const replacements = new Map<
    OrchestrationV2ProjectedTurnItem,
    OrchestrationV2ProjectedTurnItem
  >();
  const changedItems: OrchestrationV2ProjectedTurnItem[] = [];
  for (let index = 0; index < before.visibleTurnItems.length; index += 1) {
    const previousItem = before.visibleTurnItems[index]!;
    const item = input.visibleTurnItems[index]!;
    if (item === previousItem) continue;
    if (isStreamingTurnItemTextUpdate(previousItem, item)) {
      replacements.set(previousItem, item);
      continue;
    }
    if (!canRederiveInPlace(input, previousItem, item)) return null;
    changedItems.push(item);
  }
  // One batch keeps the attempt/node/plan lookups to a single build.
  const rederived =
    changedItems.length === 0
      ? []
      : deriveTimelineEntriesFromVisibleTurnItems({
          ...input,
          visibleTurnItems: changedItems,
          optimisticMessages: [],
          anchoredMessages: [],
        });
  if (
    rederived.length !== changedItems.length ||
    rederived.some((entry, index) => entry.id !== changedItems[index]!.item.id)
  ) {
    return null;
  }
  const rederivedEntries = new Map(rederived.map((entry) => [entry.id, entry]));
  if (replacements.size === 0 && rederivedEntries.size === 0 && !appended) {
    return previous.entries;
  }
  let rederivedCount = 0;
  const entries = previous.entries.map((entry): TimelineEntry => {
    const rederivedEntry = rederivedEntries.get(entry.id);
    if (rederivedEntry !== undefined) {
      rederivedCount += 1;
      return rederivedEntry;
    }
    const row =
      entry.kind === "message" && entry.projectedItem !== undefined
        ? replacements.get(entry.projectedItem)
        : undefined;
    if (entry.kind !== "message" || row?.item.type !== "assistant_message") return entry;
    return {
      ...entry,
      projectedItem: row,
      message: {
        ...entry.message,
        text: row.item.text,
        updatedAt: DateTime.formatIso(row.item.updatedAt),
      },
    };
  });
  if (rederivedCount !== rederivedEntries.size) return null;
  if (appended) {
    entries.push(
      ...deriveTimelineEntriesFromVisibleTurnItems({
        ...input,
        visibleTurnItems: input.visibleTurnItems.slice(before.visibleTurnItems.length),
      }),
    );
  }
  return entries;
}

export function deriveTimelineEntriesFromVisibleTurnItemsWithState(
  input: TimelineEntriesInput,
  previous: TimelineEntriesProjection | null = null,
): TimelineEntriesProjection {
  const reused = previous === null ? null : reuseTimelineEntries(input, previous);
  if (reused !== null) return { input, entries: reused };
  const entries = deriveTimelineEntriesFromVisibleTurnItems(input);
  if (previous === null || !shallow(input.attachmentUrlById, previous.input.attachmentUrlById)) {
    return { input, entries };
  }
  const previousMessages = new Map(
    previous.entries.flatMap((entry) =>
      entry.kind === "message" ? [[entry.id, entry] as const] : [],
    ),
  );
  return {
    input,
    entries: entries.map((entry) => {
      if (entry.kind !== "message" || entry.projectedItem === undefined) return entry;
      const before = previousMessages.get(entry.id);
      if (before?.projectedItem !== entry.projectedItem) return entry;
      return before.attempt === entry.attempt ? before : { ...entry, message: before.message };
    }),
  };
}

// Run ordinals keep increasing after a rewind; only visible local runs define predecessors.
export function deriveRevertTurnCountByUserMessageId(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
  readonly threadStartCheckpointReady: boolean;
  readonly availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  readonly unsettledRunId?: RunId | null;
}): Map<ChatMessage["id"], number> {
  const readyTurnCountByRunId = new Map<RunId, number>();
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status === "ready") {
      readyTurnCountByRunId.set(checkpoint.runId, checkpoint.checkpointTurnCount);
    }
  }
  const targetByRunId = new Map<RunId, number | undefined>();
  const byUserMessageId = new Map<ChatMessage["id"], number>();
  let previousRunId: RunId | null = null;
  for (const entry of input.timelineEntries) {
    // Inherited history belongs to the source thread, not our checkpoint scope.
    if (entry.kind !== "message" && entry.kind !== "work") continue;
    const projectedItem =
      entry.kind === "message" ? entry.projectedItem : entry.entry.projectedItem;
    if (projectedItem?.visibility === "inherited") continue;
    const runId =
      entry.kind === "message"
        ? entry.message.runId
        : entry.entry.itemType === "notification"
          ? entry.entry.runId
          : null;
    if (runId == null) continue;
    if (!targetByRunId.has(runId)) {
      targetByRunId.set(
        runId,
        previousRunId === null
          ? input.threadStartCheckpointReady
            ? 0
            : undefined
          : readyTurnCountByRunId.get(previousRunId),
      );
      previousRunId = runId;
    }
    if (entry.kind !== "message") continue;
    const { message } = entry;
    if (message.role !== "user" || message.runId === input.unsettledRunId) continue;
    if (message.inputIntent !== "turn_start" && message.inputIntent !== "queued_turn") continue;
    const target = targetByRunId.get(runId);
    if (
      target !== undefined &&
      (input.availableRevertTurnCounts === undefined || input.availableRevertTurnCounts.has(target))
    )
      byUserMessageId.set(message.id, target);
  }
  return byUserMessageId;
}

export function findRevertCheckpoint(
  checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>,
  turnCount: number,
): OrchestrationV2Checkpoint | undefined {
  return checkpoints.findLast(
    (checkpoint) =>
      checkpoint.status === "ready" &&
      (turnCount === 0
        ? checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null
        : checkpoint.appRunOrdinal === turnCount),
  );
}

export function derivePhase(runtime: ThreadStructureRuntime | null): SessionPhase {
  if (runtime === null) return "disconnected";
  if (
    runtime.status === "preparing" ||
    runtime.status === "starting" ||
    runtime.status === "queued"
  )
    return "connecting";
  if (runtime.status === "running" || runtime.status === "waiting") return "running";
  return "ready";
}

/** Preparing and starting runs can be interrupted; Stop need not wait for running. */
export function deriveCanInterruptRunningThread(
  hasActiveThread: boolean,
  runtime: ThreadStructureRuntime | null,
): boolean {
  return (
    hasActiveThread &&
    (derivePhase(runtime) === "running" || threadRuntimeHasInterruptibleRun(runtime))
  );
}

export type { TurnDiffSummary };

