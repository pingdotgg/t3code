import {
  EventId,
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type TeamSyncLocalThreadInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

/**
 * Deterministically namespaces mirrored run/message/turn-item IDs under the owning `threadId`
 * using `encodeURIComponent` (which percent-encodes `:` and `%`) so `(threadId, kind, rawId)` is
 * bijective and collision-free across all possible custom IDs.
 */
export const localSyncMirroredRunId = (threadId: ThreadId, rawRunId: string): RunId =>
  RunId.make(`local-sync:${encodeURIComponent(threadId)}:run:${encodeURIComponent(rawRunId)}`);

export const localSyncMirroredMessageId = (threadId: ThreadId, rawMessageId: string): MessageId =>
  MessageId.make(
    `local-sync:${encodeURIComponent(threadId)}:msg:${encodeURIComponent(rawMessageId)}`,
  );

const localSyncMirroredTurnItemId = (threadId: ThreadId, rawMessageId: string): TurnItemId =>
  TurnItemId.make(
    `local-sync:${encodeURIComponent(threadId)}:item:${encodeURIComponent(rawMessageId)}`,
  );

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

function isTerminalRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Mirrors a member's local-environment team thread into the Team Server's orchestration
 * projection via read-only `EventSink.write` (zero provider effects). Colleagues with Read
 * access to the thread's View see live updates and full read-only history even while the
 * owner's laptop is offline.
 */
export const mirrorLocalThreadSnapshotToEventSink = Effect.fn(
  "TeamLocalSync.mirrorLocalThreadSnapshotToEventSink",
)(function* (input: {
  readonly eventSink: EventSink.EventSinkV2["Service"];
  readonly projectionStore: ProjectionStore.ProjectionStoreV2["Service"];
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly sync: TeamSyncLocalThreadInput;
}) {
  const { eventSink, projectionStore, random, sync } = input;
  const existing = yield* projectionStore
    .getThreadProjection(sync.threadId)
    .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
  const now = yield* DateTime.now;
  const createdAt = DateTime.makeUnsafe(sync.createdAt);
  const updatedAt = DateTime.makeUnsafe(sync.updatedAt);
  if (existing?.thread.deletedAt != null) return;
  const archivedAt =
    sync.archivedAt !== undefined
      ? sync.archivedAt !== null
        ? DateTime.makeUnsafe(sync.archivedAt)
        : null
      : (existing?.thread.archivedAt ?? null);
  const deletedAt =
    sync.deletedAt !== undefined
      ? sync.deletedAt !== null
        ? DateTime.makeUnsafe(sync.deletedAt)
        : null
      : (existing?.thread.deletedAt ?? null);

  const nextEventId = () => random.uuidV4().pipe(Effect.map((id) => EventId.make(id)));
  const events: Array<OrchestrationV2DomainEvent> = [];

  const threadPayload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: sync.threadId,
    projectId: sync.projectId,
    title: sync.title,
    providerInstanceId: sync.modelSelection.instanceId,
    modelSelection: sync.modelSelection,
    runtimeMode: sync.runtimeMode ?? "auto",
    interactionMode: sync.interactionMode ?? "default",
    branch: sync.branch,
    worktreePath: null,
    activeProviderThreadId: existing?.thread.activeProviderThreadId ?? null,
    lineage: existing?.thread.lineage ?? {
      rootThreadId: sync.threadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: existing?.thread.forkedFrom ?? null,
    createdAt: existing?.thread.createdAt ?? createdAt,
    updatedAt,
    archivedAt,
    settledOverride: existing?.thread.settledOverride ?? null,
    settledAt: existing?.thread.settledAt ?? null,
    lastVisitedAt: existing?.thread.lastVisitedAt ?? null,
    deletedAt,
    titleRenamed: true,
  };

  const prevArchivedMs =
    existing?.thread.archivedAt != null ? DateTime.toEpochMillis(existing.thread.archivedAt) : null;
  const nextArchivedMs = archivedAt != null ? DateTime.toEpochMillis(archivedAt) : null;
  const prevDeletedMs =
    existing?.thread.deletedAt != null ? DateTime.toEpochMillis(existing.thread.deletedAt) : null;
  const nextDeletedMs = deletedAt != null ? DateTime.toEpochMillis(deletedAt) : null;

  if (existing === null) {
    events.push({
      id: yield* nextEventId(),
      threadId: sync.threadId,
      occurredAt: now,
      type: "thread.created",
      payload: threadPayload,
    });
  } else if (prevDeletedMs === null && nextDeletedMs !== null) {
    events.push({
      id: yield* nextEventId(),
      threadId: sync.threadId,
      occurredAt: now,
      type: "thread.deleted",
      payload: threadPayload,
    });
  } else if (prevArchivedMs !== nextArchivedMs) {
    events.push({
      id: yield* nextEventId(),
      threadId: sync.threadId,
      occurredAt: now,
      type: nextArchivedMs !== null ? "thread.archived" : "thread.unarchived",
      payload: threadPayload,
    });
  } else if (
    existing.thread.title !== threadPayload.title ||
    existing.thread.branch !== threadPayload.branch ||
    DateTime.toEpochMillis(existing.thread.updatedAt) !== DateTime.toEpochMillis(updatedAt)
  ) {
    events.push({
      id: yield* nextEventId(),
      threadId: sync.threadId,
      occurredAt: now,
      type: "thread.metadata-updated",
      payload: threadPayload,
    });
  }

  const existingRunsById = new Map(
    (existing?.runs ?? []).map((run) => [run.id as string, run] as const),
  );
  for (const syncedRun of sync.runs) {
    const runId = localSyncMirroredRunId(sync.threadId, syncedRun.id);
    const prevRun = existingRunsById.get(runId);
    const runCreatedAt = DateTime.makeUnsafe(syncedRun.createdAt);
    const runCompletedAt =
      syncedRun.completedAt !== null ? DateTime.makeUnsafe(syncedRun.completedAt) : null;
    const runPayload: OrchestrationV2Run = {
      id: runId,
      threadId: sync.threadId,
      ordinal: Math.max(1, syncedRun.ordinal),
      providerInstanceId: sync.modelSelection.instanceId,
      modelSelection: sync.modelSelection,
      providerThreadId: null,
      userMessageId: localSyncMirroredMessageId(sync.threadId, syncedRun.userMessageId),
      rootNodeId: null,
      activeAttemptId: null,
      status: syncedRun.status,
      requestedAt: runCreatedAt,
      startedAt: syncedRun.status === "queued" ? null : runCreatedAt,
      completedAt: runCompletedAt,
      checkpointId: null,
      contextHandoffId: null,
    };
    if (!prevRun) {
      events.push({
        id: yield* nextEventId(),
        threadId: sync.threadId,
        occurredAt: now,
        type: "run.created",
        payload: runPayload,
      });
    } else {
      const regressesTerminalStatus =
        isTerminalRunStatus(prevRun.status) && !isTerminalRunStatus(runPayload.status);
      const clearsCompletedAt = prevRun.completedAt !== null && runPayload.completedAt === null;
      if (
        !regressesTerminalStatus &&
        !clearsCompletedAt &&
        (prevRun.status !== runPayload.status ||
          prevRun.ordinal !== runPayload.ordinal ||
          prevRun.userMessageId !== runPayload.userMessageId ||
          (prevRun.completedAt !== null ? DateTime.toEpochMillis(prevRun.completedAt) : null) !==
            (runPayload.completedAt !== null
              ? DateTime.toEpochMillis(runPayload.completedAt)
              : null))
      ) {
        events.push({
          id: yield* nextEventId(),
          threadId: sync.threadId,
          occurredAt: now,
          type: "run.updated",
          payload: runPayload,
        });
      }
    }
  }

  const existingMessagesById = new Map(
    (existing?.messages ?? []).map((message) => [message.id as string, message] as const),
  );
  const existingTurnItemsById = new Map(
    (existing?.turnItems ?? []).map((item) => [item.id as string, item] as const),
  );
  for (let index = 0; index < sync.messages.length; index += 1) {
    const syncedMessage = sync.messages[index]!;
    const messageId = localSyncMirroredMessageId(sync.threadId, syncedMessage.id);
    const prevMessage = existingMessagesById.get(messageId);
    const msgCreatedAt = DateTime.makeUnsafe(syncedMessage.createdAt);
    const msgUpdatedAt = DateTime.makeUnsafe(syncedMessage.updatedAt ?? syncedMessage.createdAt);
    const resolvedRunId =
      syncedMessage.runId !== null
        ? localSyncMirroredRunId(sync.threadId, syncedMessage.runId)
        : null;
    const isStaleMessage =
      prevMessage !== undefined &&
      DateTime.toEpochMillis(msgUpdatedAt) < DateTime.toEpochMillis(prevMessage.updatedAt);
    if (isStaleMessage) {
      continue;
    }
    const messageChanged =
      !prevMessage ||
      prevMessage.text !== syncedMessage.text ||
      prevMessage.runId !== resolvedRunId;
    if (messageChanged) {
      const messagePayload: OrchestrationV2ConversationMessage = {
        createdBy: syncedMessage.role === "assistant" ? "agent" : "user",
        creationSource: syncedMessage.role === "assistant" ? "provider" : "web",
        id: messageId,
        threadId: sync.threadId,
        runId: resolvedRunId,
        nodeId: null,
        role: syncedMessage.role,
        text: syncedMessage.text,
        attachments: [],
        streaming: false,
        createdAt: msgCreatedAt,
        updatedAt: msgUpdatedAt,
      };
      events.push({
        id: yield* nextEventId(),
        threadId: sync.threadId,
        ...(resolvedRunId !== null ? { runId: resolvedRunId } : {}),
        occurredAt: now,
        type: "message.updated",
        payload: messagePayload,
      });
    }
    if (syncedMessage.role === "user" || syncedMessage.role === "assistant") {
      const turnItemId = localSyncMirroredTurnItemId(sync.threadId, syncedMessage.id);
      const prevItem = existingTurnItemsById.get(turnItemId);
      const prevText =
        prevItem && (prevItem.type === "user_message" || prevItem.type === "assistant_message")
          ? prevItem.text
          : null;
      if (!prevItem || prevText !== syncedMessage.text) {
        const baseFields = {
          id: turnItemId,
          threadId: sync.threadId,
          runId: resolvedRunId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index + 1,
          status: "completed" as const,
          title: null,
          startedAt: msgCreatedAt,
          completedAt: msgUpdatedAt,
          updatedAt: msgUpdatedAt,
        };
        const turnItemPayload: OrchestrationV2TurnItem =
          syncedMessage.role === "user"
            ? {
                ...baseFields,
                createdBy: "user",
                creationSource: "web",
                type: "user_message",
                messageId,
                inputIntent: "turn_start",
                text: syncedMessage.text,
                attachments: [],
              }
            : {
                ...baseFields,
                type: "assistant_message",
                messageId,
                text: syncedMessage.text,
                streaming: false,
              };
        events.push({
          id: yield* nextEventId(),
          threadId: sync.threadId,
          ...(resolvedRunId !== null ? { runId: resolvedRunId } : {}),
          occurredAt: now,
          type: "turn-item.updated",
          payload: turnItemPayload,
        });
      }
    }
  }

  if (events.length > 0) {
    yield* eventSink.write({ events });
  }
});
