import { applyThreadPullRequestLinkUpdate } from "../../sourceControl/threadPullRequests.ts";
import * as Stream from "effect/Stream";
import type { OrchestrationV2SearchThreadInput, OrchestrationV2SearchThreadResult, OrchestrationV2ThreadHistoryPage } from "@t3tools/contracts";
import type { OrchestrationV2AppThread, OrchestrationV2ExecutionNode, OrchestrationV2PlanArtifact, PlanId, OrchestrationV2ConversationMessage, OrchestrationV2DomainEvent, OrchestrationV2ProjectedTurnItem, OrchestrationV2ProviderThread, OrchestrationV2ProviderTurn, OrchestrationV2Run, OrchestrationV2Subagent, OrchestrationV2ThreadShellSnapshot, OrchestrationV2ThreadShell, OrchestrationV2ThreadProjection, OrchestrationV2TurnItem, GuestShareId, ProviderThreadId, ProviderTurnId } from "@t3tools/contracts";
import { RunId, RuntimeRequestId, CheckpointScopeId, CheckpointId, ThreadId, TurnItemId, NodeId, ProviderInstanceId } from "@t3tools/contracts";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ProjectionStoreApplyEventError, ProjectionStoreSetupError, ProjectionStoreThreadNotFoundError, ProjectionStoreReadError, decodeCheckpointContext, RollbackTargetAttempts, decodeRollbackTargetAttempts, inheritsForkConversation, PullRequestThread, type ProjectionStoreV2Error, type ProjectionRecoveryKind, type ProjectionLimitRecoveryCandidate, type ProjectionThreadPullRequests, type ProjectionSettlementCandidate, type ProjectionCheckpointContext, type ProjectionCheckpointCaptureContext, type ProjectionCheckpointRollbackContext, type ProjectionProviderControlContext, type ProjectionProviderControlTarget, type ProjectionRuntimeRecoveryState, type ProjectionPendingUserInputs, type ProjectionThreadProviderContext, type ProjectionRuntimeResponseContext, type ProjectionRecordFilter, type ProjectionRecordField, type ProjectionRecords, type ProjectionTimelinePageOptions, type ProjectionTimelinePage, type ShellSnapshotOptions, type ActiveShellIndexEntry, type OlderSettledThreadsQuery, type OlderSettledThreadsListing } from "./ProjectionSettlementCandidate.ts";

export interface ProjectionStoreV2Shape {
readonly searchThreadStream: (
  input: OrchestrationV2SearchThreadInput,
) => Stream.Stream<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
readonly searchThread: (
  input: OrchestrationV2SearchThreadInput,
) => Effect.Effect<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
readonly getThreadAttachmentIds: (
  threadId: ThreadId,
) => Effect.Effect<ReadonlyArray<string>, ProjectionStoreV2Error>;
readonly getThreadHistoryPage: (
  threadId: ThreadId,
  cursor: string,
  throughEntryId?: string,
  conversationOnly?: boolean,
  workMode?: "deferred" | "work",
) => Effect.Effect<OrchestrationV2ThreadHistoryPage, ProjectionStoreV2Error>;
readonly getTimelinePage: (
  threadId: ThreadId,
  options: ProjectionTimelinePageOptions,
) => Effect.Effect<ProjectionTimelinePage, ProjectionStoreV2Error>;
readonly getMessageCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionStoreV2Error>;
readonly getSubagentCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionStoreV2Error>;
/** Child threads of the thread's app-owned tasks, in task order, without decoding the tasks. */
readonly listAppOwnedChildThreadIds: (
  threadId: ThreadId,
) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionStoreV2Error>;
readonly getNextTurnItemOrdinal: (
  threadId: ThreadId,
) => Effect.Effect<number, ProjectionStoreV2Error>;
readonly getTurnItem: (input: {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}) => Effect.Effect<OrchestrationV2TurnItem | null, ProjectionStoreV2Error>;
readonly getThreadRecords: <K extends ProjectionRecordField>(
  threadId: ThreadId,
  fields: ReadonlyArray<K>,
  filter?: ProjectionRecordFilter,
) => Effect.Effect<ProjectionRecords<K>, ProjectionStoreV2Error>;

readonly apply: (
  event: OrchestrationV2DomainEvent,
) => Effect.Effect<void, ProjectionStoreV2Error>;
readonly getPullRequestSnapshot: (options: {
  readonly threadId?: ThreadId;
  readonly unsettledOnly?: boolean;
}) => Effect.Effect<
  {
    readonly snapshotSequence: number;
    readonly threads: ReadonlyArray<typeof PullRequestThread.Type>;
  },
  ProjectionStoreV2Error
>;
readonly getShellSnapshot: (
  options?: ShellSnapshotOptions,
) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>;
readonly listActiveSubagentThreadIds: () => Effect.Effect<
  ReadonlyArray<ThreadId>,
  ProjectionStoreV2Error
>;
/** Threads that are not deleted, archived ones included. */
readonly countThreads: () => Effect.Effect<number, ProjectionStoreV2Error>;
/** Every active thread, in shell order. */
readonly listActiveShellIndex: () => Effect.Effect<
  ReadonlyArray<ActiveShellIndexEntry>,
  ProjectionStoreV2Error
>;
/** Older settled thread ids below a cursor, newest settle first, and per-project counts. */
readonly listOlderSettledThreads: (
  query: OlderSettledThreadsQuery,
) => Effect.Effect<OlderSettledThreadsListing, ProjectionStoreV2Error>;
/**
 * Callers that combine the shell with other reads run this inside their own
 * transaction and the returned decode after it commits, so the shared
 * connection is not held while thousands of rows are converted.
 */
readonly readShellSnapshot: (
  options?: ShellSnapshotOptions,
) => Effect.Effect<
  Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>,
  ProjectionStoreV2Error
>;
readonly getThreadShell: (
  threadId: ThreadId,
) => Effect.Effect<OrchestrationV2ThreadShell | null, ProjectionStoreV2Error>;
/** The thread whose current guest share has this id. Scans thread rows; only redeem uses it. */
readonly findGuestShareThreadId: (
  shareId: GuestShareId,
) => Effect.Effect<ThreadId | null, ProjectionStoreV2Error>;
readonly getThread: (
  threadId: ThreadId,
) => Effect.Effect<OrchestrationV2AppThread, ProjectionStoreV2Error>;
readonly getLimitRecoveryCandidates: (options: {
  readonly now: DateTime.Utc;
  readonly autoResume: boolean;
  readonly snooze: boolean;
}) => Effect.Effect<ReadonlyArray<ProjectionLimitRecoveryCandidate>, ProjectionStoreV2Error>;
/** Epoch ms of the next armed reset or snooze end after `now`, when a waiting thread becomes a candidate. */
readonly getLimitRecoveryWakeAt: (
  now: DateTime.Utc,
) => Effect.Effect<number | null, ProjectionStoreV2Error>;
readonly getSettlementCandidates: (
  threadId?: ThreadId,
) => Effect.Effect<ReadonlyArray<ProjectionSettlementCandidate>, ProjectionStoreV2Error>;
readonly getThreadsWithPullRequests: (
  threadId?: ThreadId,
) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequests>, ProjectionStoreV2Error>;
readonly getThreadWorktreePaths: (options?: {
  readonly includeArchived?: boolean;
}) => Effect.Effect<
  ReadonlyArray<{ readonly threadId: ThreadId; readonly worktreePath: string }>,
  ProjectionStoreV2Error
>;
/**
 * Delegated tasks in a linked environment with work left for this one: no
 * result yet, or cancelled or stopped here without that stop reaching there,
 * including a Stop after the task had its result.
 */
readonly getOpenRemoteDelegatedTasks: Effect.Effect<
  ReadonlyArray<{ readonly parentThreadId: ThreadId; readonly taskId: NodeId }>,
  ProjectionStoreV2Error
>;
readonly getTurnStartContext: (
  threadId: ThreadId,
  runId: RunId,
) => Effect.Effect<
  Pick<
    OrchestrationV2ThreadProjection,
    | "thread"
    | "runs"
    | "attempts"
    | "nodes"
    | "subagents"
    | "providerSessions"
    | "providerThreads"
    | "providerTurns"
    | "messages"
    | "checkpointScopes"
    | "contextHandoffs"
    | "contextTransfers"
    | "turnItems"
  > & { readonly hasConversation: boolean },
  ProjectionStoreV2Error
>;
readonly getTurnStartHistory: (
  threadId: ThreadId,
  runIds?: ReadonlyArray<RunId>,
) => Effect.Effect<ReadonlyArray<OrchestrationV2TurnItem>, ProjectionStoreV2Error>;
readonly getThreadProjection: (
  threadId: ThreadId,
) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
readonly getRuntimeRecoveryProjection: (
  threadId: ThreadId,
) => Effect.Effect<ProjectionRuntimeRecoveryState, ProjectionStoreV2Error>;
readonly getPendingNativeUserInputs: (
  threadId: ThreadId,
  providerTurnId: ProviderTurnId,
) => Effect.Effect<ProjectionPendingUserInputs, ProjectionStoreV2Error>;
readonly getPlan: (
  threadId: ThreadId,
  planId: PlanId,
) => Effect.Effect<OrchestrationV2PlanArtifact | undefined, ProjectionStoreV2Error>;
readonly hasUnpairedRunInterruptRequest: (
  threadId: ThreadId,
  requestId: TurnItemId,
  resultId: TurnItemId,
) => Effect.Effect<boolean, ProjectionStoreV2Error>;
readonly isNodeStored: (
  node: OrchestrationV2ExecutionNode,
) => Effect.Effect<boolean, ProjectionStoreV2Error>;
readonly getRuntimeRequest: (
  threadId: ThreadId,
  requestId: RuntimeRequestId,
) => Effect.Effect<
  OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined,
  ProjectionStoreV2Error
>;
readonly getProviderControlContext: (
  threadId: ThreadId,
  target: ProjectionProviderControlTarget,
) => Effect.Effect<ProjectionProviderControlContext, ProjectionStoreV2Error>;
readonly getRunningTurnContext: (
  threadId: ThreadId,
) => Effect.Effect<
  Pick<ProjectionProviderControlContext, "run" | "providerThread" | "providerTurn">,
  ProjectionStoreV2Error
>;
readonly getThreadProviderContext: (
  threadId: ThreadId,
  targetInstanceId?: ProviderInstanceId,
) => Effect.Effect<ProjectionThreadProviderContext, ProjectionStoreV2Error>;
readonly getRuntimeResponseContext: (
  threadId: ThreadId,
  requestId: RuntimeRequestId,
) => Effect.Effect<ProjectionRuntimeResponseContext, ProjectionStoreV2Error>;
readonly getCheckpointContext: (
  threadId: ThreadId,
) => Effect.Effect<ProjectionCheckpointContext, ProjectionStoreV2Error>;
readonly getCheckpointCaptureContext: (
  threadId: ThreadId,
  target: { readonly runId: RunId; readonly scopeId: CheckpointScopeId },
) => Effect.Effect<ProjectionCheckpointCaptureContext, ProjectionStoreV2Error>;
readonly getCheckpointRollbackContext: (
  threadId: ThreadId,
  target: {
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
  },
) => Effect.Effect<ProjectionCheckpointRollbackContext, ProjectionStoreV2Error>;
readonly getRunMessage: (
  threadId: ThreadId,
  runId: RunId,
) => Effect.Effect<OrchestrationV2ConversationMessage | undefined, ProjectionStoreV2Error>;
readonly canStartQueuedRun: (
  threadId: ThreadId,
) => Effect.Effect<boolean, ProjectionStoreV2Error>;
readonly getHeldQueuedRuns: (
  threadId: ThreadId,
) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>, ProjectionStoreV2Error>;
readonly getRecoveryThreadIds: (
  kind: ProjectionRecoveryKind,
) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionStoreV2Error>;
readonly getUnreadableThreadIds: () => Effect.Effect<
  ReadonlyArray<ThreadId>,
  ProjectionStoreV2Error
>;
readonly getThreadSnapshot: (threadId: ThreadId) => Effect.Effect<
  {
    readonly schemaVersion: number;
    readonly snapshotSequence: number;
    readonly projection: OrchestrationV2ThreadProjection;
  },
  ProjectionStoreV2Error
>;
readonly getThreadSnapshotWindow: (
  threadId: ThreadId,
  options: {
    readonly rowLimit: number;
    readonly userTurnLimit?: number | undefined;
    readonly deferWork?: boolean | undefined;
    readonly anchorItemId?: TurnItemId | undefined;
    readonly anchorThreadId?: ThreadId | undefined;
    readonly requiredRunId?: RunId | undefined;
  },
) => Effect.Effect<
  {
    readonly schemaVersion: number;
    readonly snapshotSequence: number;
    readonly projection: OrchestrationV2ThreadProjection;
  },
  ProjectionStoreV2Error
>;
}

export type ProjectionWindow = Omit<
Parameters<ProjectionStoreV2Shape["getThreadSnapshotWindow"]>[1],
"anchorThreadId"
> & {
readonly suppressLocal?: boolean | undefined;
readonly historyAnchor?: { readonly threadId: ThreadId; readonly itemId: TurnItemId } | undefined;
};

export const ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION = 2;

export function upsertById<T extends { readonly id: string }>(items: ReadonlyArray<T>, next: T): Array<T> {
const index = items.findIndex((item) => item.id === next.id);
if (index === -1) {
  return [...items, next];
}

const updated = [...items];
updated[index] = next;
return updated;
}

export function upsertProviderTurn(
turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
next: OrchestrationV2ProviderTurn,
): Array<OrchestrationV2ProviderTurn> {
const current = turns.find((turn) => turn.id === next.id);
return upsertById(turns, {
  ...next,
  ...((next.tokenUsage ?? current?.tokenUsage) === undefined
    ? {}
    : { tokenUsage: next.tokenUsage ?? current?.tokenUsage }),
});
}

export function preserveRunRecordedFields(
current: OrchestrationV2Run | undefined,
next: OrchestrationV2Run,
): OrchestrationV2Run {
if (current === undefined) return next;
return {
  ...next,
  ...(next.delegatedCompletion === undefined && current.delegatedCompletion !== undefined
    ? { delegatedCompletion: current.delegatedCompletion }
    : {}),
  ...(next.restartCancelledBackgroundWork === undefined &&
  current.restartCancelledBackgroundWork !== undefined
    ? { restartCancelledBackgroundWork: current.restartCancelledBackgroundWork }
    : {}),
};
}

export function preserveCompletionDelivery(
current: OrchestrationV2Subagent | undefined,
next: OrchestrationV2Subagent,
): OrchestrationV2Subagent {
if (next.completionDelivery !== undefined || current?.completionDelivery === undefined) {
  return next;
}
return { ...next, completionDelivery: current.completionDelivery };
}

export function emptyProjection(
event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
): OrchestrationV2ThreadProjection {
return {
  thread: event.payload,
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: event.occurredAt,
};
}

export function isQueuedProviderThreadPlaceholder(providerThread: OrchestrationV2ProviderThread): boolean {
return (
  providerThread.status === "not_loaded" &&
  providerThread.firstRunOrdinal === null &&
  providerThread.nativeThreadRef === null &&
  providerThread.providerSessionId === null
);
}

export function applyToProjection(
projection: OrchestrationV2ThreadProjection,
event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection {
const base = {
  ...projection,
  thread: {
    ...projection.thread,
    updatedAt: event.occurredAt,
  },
  updatedAt: event.occurredAt,
};

switch (event.type) {
  case "thread.pull-request-link-updated":
    return {
      ...projection,
      thread: applyThreadPullRequestLinkUpdate(projection.thread, event.payload),
    };
  case "thread.created":
  case "thread.archived":
  case "thread.unarchived":
  case "thread.deleted":
  case "thread.settled":
  case "thread.unsettled":
  case "thread.snoozed":
  case "thread.unsnoozed":
  case "thread.auto-settle-set":
  case "thread.pinned":
  case "thread.unpinned":
  case "thread.pin-reordered":
  case "thread.metadata-updated":
  case "thread.runtime-mode-updated":
  case "thread.interaction-mode-updated":
  case "thread.model-selection-updated":
  case "thread.provider-switched":
  case "thread.guest-share-updated":
    return {
      ...base,
      thread: event.payload,
    };
  // Reordering and PR refreshes preserve the orchestrator's activity timestamp.
  case "thread.active-reordered":
  case "thread.tags-updated":
  case "thread.pull-request-synced":
    return {
      ...base,
      thread: event.payload,
      updatedAt: event.payload.updatedAt,
    };
  case "thread.visited":
  case "thread.marked-unread":
    return {
      ...projection,
      thread: event.payload,
    };
  case "run.created":
  case "run.updated":
    return withLocalVisibleTurnItems({
      ...base,
      runs: upsertById(
        base.runs,
        preserveRunRecordedFields(
          base.runs.find((run) => run.id === event.payload.id),
          event.payload,
        ),
      ),
    });
  case "run.background-work-cancelled":
    return {
      ...base,
      runs: base.runs.map((run) =>
        run.id === event.payload.runId
          ? {
              ...run,
              restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
            }
          : run,
      ),
    };
  case "run-attempt.created":
  case "run-attempt.updated":
    return withLocalVisibleTurnItems({
      ...base,
      attempts: upsertById(base.attempts, event.payload),
    });
  case "node.updated":
    return {
      ...base,
      nodes: upsertById(base.nodes, event.payload),
    };
  case "subagent.updated":
    return {
      ...base,
      subagents: upsertById(
        base.subagents,
        preserveCompletionDelivery(
          base.subagents.find((task) => task.id === event.payload.id),
          event.payload,
        ),
      ),
    };
  case "provider-session.attached":
  case "provider-session.updated":
    return {
      ...base,
      providerSessions: upsertById(base.providerSessions, event.payload),
    };
  case "provider-session.detached":
    return {
      ...base,
      providerSessions: base.providerSessions.filter(
        (session) => session.id !== event.payload.providerSessionId,
      ),
    };
  case "provider-thread.updated":
    return {
      ...base,
      thread:
        event.payload.appThreadId === base.thread.id &&
        !isQueuedProviderThreadPlaceholder(event.payload)
          ? {
              ...base.thread,
              activeProviderThreadId: event.payload.id,
            }
          : base.thread,
      providerThreads: upsertById(base.providerThreads, event.payload),
    };
  case "provider-turn.updated":
    return {
      ...base,
      providerTurns: upsertProviderTurn(base.providerTurns, event.payload),
    };
  case "runtime-request.updated":
    return {
      ...base,
      runtimeRequests: upsertById(base.runtimeRequests, event.payload),
    };
  case "message.updated":
    return {
      ...base,
      messages: upsertById(base.messages, event.payload),
    };
  case "turn-item.updated":
    return withLocalVisibleTurnItems({
      ...base,
      turnItems: upsertById(base.turnItems, event.payload),
    });
  case "plan.updated":
    return {
      ...base,
      plans: upsertById(base.plans, event.payload),
    };
  case "checkpoint-scope.created":
    return {
      ...base,
      checkpointScopes: upsertById(base.checkpointScopes, event.payload),
    };
  case "checkpoint.captured":
    return {
      ...base,
      checkpoints: upsertById(base.checkpoints, event.payload),
    };
  case "checkpoint.rollback-requested":
    return base;
  case "context-handoff.updated":
    return {
      ...base,
      contextHandoffs: upsertById(base.contextHandoffs, event.payload),
    };
  case "context-transfer.created":
  case "context-transfer.updated":
    return {
      ...base,
      contextTransfers: upsertById(base.contextTransfers, event.payload),
    };
}
}

export type PayloadRow = {
readonly payload_json: string;
};

export type ShellPendingTurnItemRow = PayloadRow & {
readonly thread_id: string;
readonly owning_provider_instance_id: string | null;
};

export function activeLocalTurnItems(
projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
const isVisible = createOrchestrationV2TurnItemVisibility({
  runs: projection.runs,
  attempts: projection.attempts,
  items: projection.turnItems,
});
return projection.turnItems.filter(isVisible).map((item, position) => ({
  position,
  visibility: "local" as const,
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
}));
}

export function localVisibleTurnItems(
projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
return activeLocalTurnItems(projection);
}

export function withLocalVisibleTurnItems(
projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
return {
  ...projection,
  visibleTurnItems: localVisibleTurnItems(projection),
};
}
