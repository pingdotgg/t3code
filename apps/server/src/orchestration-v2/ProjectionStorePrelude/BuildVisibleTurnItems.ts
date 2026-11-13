import type { OrchestrationV2AppThread, OrchestrationV2PendingRuntimeRequestSummary, OrchestrationV2ConversationMessage, OrchestrationV2ProjectedTurnItem, OrchestrationV2ThreadShell, OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { idleCompactionOf, OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema, OrchestrationV2CheckpointJson as OrchestrationV2CheckpointJsonSchema, OrchestrationV2CheckpointScopeJson as OrchestrationV2CheckpointScopeJsonSchema, OrchestrationV2ContextHandoffJson as OrchestrationV2ContextHandoffJsonSchema, OrchestrationV2ContextTransferJson as OrchestrationV2ContextTransferJsonSchema, OrchestrationV2ConversationMessageJson as OrchestrationV2ConversationMessageJsonSchema, OrchestrationV2ExecutionNodeJson as OrchestrationV2ExecutionNodeJsonSchema, OrchestrationV2PlanArtifact as OrchestrationV2PlanArtifactSchema, OrchestrationV2ProviderSessionJson as OrchestrationV2ProviderSessionJsonSchema, OrchestrationV2ProviderThreadJson as OrchestrationV2ProviderThreadJsonSchema, OrchestrationV2ProviderTurnJson as OrchestrationV2ProviderTurnJsonSchema, OrchestrationV2RunAttemptJson as OrchestrationV2RunAttemptJsonSchema, OrchestrationV2RunJson as OrchestrationV2RunJsonSchema, OrchestrationV2RuntimeRequestJson as OrchestrationV2RuntimeRequestJsonSchema, OrchestrationV2SubagentJson as OrchestrationV2SubagentJsonSchema, OrchestrationV2TurnItemJson as OrchestrationV2TurnItemJsonSchema, RunId, RuntimeRequestId, ThreadId, TurnItemId, ProviderInstanceId } from "@t3tools/contracts";
import { isOrchestrationV2SupersededInterrupt } from "@t3tools/shared/orchestrationV2Timeline";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProjectionStoreApplyEventError, ProjectionStoreSetupError, ProjectionStoreThreadNotFoundError, ProjectionStoreReadError, decodeCheckpointContext, RollbackTargetAttempts, decodeRollbackTargetAttempts, inheritsForkConversation, PullRequestThread, type ProjectionStoreV2Error, type ProjectionRecoveryKind, type ProjectionLimitRecoveryCandidate, type ProjectionThreadPullRequests, type ProjectionSettlementCandidate, type ProjectionCheckpointContext, type ProjectionCheckpointCaptureContext, type ProjectionCheckpointRollbackContext, type ProjectionProviderControlContext, type ProjectionProviderControlTarget, type ProjectionRuntimeRecoveryState, type ProjectionPendingUserInputs, type ProjectionThreadProviderContext, type ProjectionRuntimeResponseContext, type ProjectionRecordFilter, type ProjectionRecordField, type ProjectionRecords, type ProjectionTimelinePageOptions, type ProjectionTimelinePage, type ShellSnapshotOptions, type ActiveShellIndexEntry, type OlderSettledThreadsQuery, type OlderSettledThreadsListing } from "./ProjectionSettlementCandidate.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION, upsertById, upsertProviderTurn, preserveRunRecordedFields, preserveCompletionDelivery, emptyProjection, isQueuedProviderThreadPlaceholder, applyToProjection, activeLocalTurnItems, localVisibleTurnItems, withLocalVisibleTurnItems, type ProjectionStoreV2Shape, type ProjectionWindow, type PayloadRow, type ShellPendingTurnItemRow } from "./ProjectionStoreV2Shape.ts";

export type ShellThreadRow = {
readonly thread_id: string;
readonly payload_json: string;
readonly forked_from_run_source_thread_id: string | null;
readonly latest_run_id: string | null;
readonly latest_run_status: string | null;
readonly latest_run_requested_at: string | null;
readonly latest_run_started_at: string | null;
readonly latest_run_completed_at: string | null;
readonly latest_run_stop_requested: number;
readonly active_run_id: string | null;
readonly active_run_status: string | null;
readonly activity_run_status: string | null;
readonly activity_run_started_at: string | null;
readonly last_error: string | null;
readonly terminal_failure_payload_json: string | null;
readonly blocking_run_id: string | null;
readonly blocking_run_requested_at: string | null;
readonly blocking_run_started_at: string | null;
readonly blocking_run_completed_at: string | null;
readonly blocking_run_stop_requested: number;
readonly blocking_failure_payload_json: string | null;
readonly pending_request_payload_json: string | null;
readonly pending_secret_request_payload_json: string | null;
readonly pending_link_request_payload_json: string | null;
readonly latest_user_message_at: string | null;
readonly latest_user_authored_message_at: string | null;
readonly has_actionable_proposed_plan: number;
};

export type ShellRunRow = {
readonly thread_id: string;
readonly run_id: string;
readonly ordinal: number;
};

export type SettlementThreadRow = Pick<
ShellThreadRow,
| "thread_id"
| "payload_json"
| "latest_run_id"
| "latest_run_status"
| "latest_run_requested_at"
| "latest_run_started_at"
| "latest_run_completed_at"
| "latest_user_message_at"
| "latest_user_authored_message_at"
>;

export type ShellRunItemCountRow = {
readonly thread_id: string;
readonly run_id: string;
readonly item_count: number;
};

export type ShellItemCountRow = {
readonly thread_id: string;
readonly item_count: number;
readonly runless_item_count: number;
};

export const encodeTimelineSources = Schema.encodeEffect(
Schema.fromJsonString(
  Schema.Array(Schema.Struct({ threadId: Schema.String, id: Schema.String })),
),
);

export const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const matchesNothing = (...filters: ReadonlyArray<ReadonlyArray<unknown> | undefined>) =>
filters.some((values) => values?.length === 0);

export const encodeThreadPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);

export const encodeThreadUpdatedAt = Schema.encodeEffect(
OrchestrationV2AppThreadJsonSchema.fields.updatedAt,
);

export const encodeRunPayload = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2RunJsonSchema));

export const encodeRestartCancelledBackgroundWork = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2RunJsonSchema.fields.restartCancelledBackgroundWork),
);

export const encodeRunAttemptPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);

export const encodeNodePayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);

export const encodeSubagentPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);

export const encodeProviderSessionPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);

export const encodeProviderThreadPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);

export const encodeProviderTurnPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);

export const encodeRuntimeRequestPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);

export const encodeMessagePayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);

export const encodePlanPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2PlanArtifactSchema),
);

export const encodeTurnItemPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);

export const encodePayloadTimestamp = Schema.encodeEffect(Schema.DateTimeUtcFromString);

export const encodeCheckpointScopePayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);

export const encodeCheckpointPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);

export const encodeContextHandoffPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);

export const encodeContextTransferPayload = Schema.encodeEffect(
Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

export const decodePullRequestThread = Schema.decodeUnknownEffect(
Schema.fromJsonString(PullRequestThread),
);

export const decodeThreadPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);

export const decodeRunPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2RunJsonSchema),
);

export const decodeRunAttemptPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);

export const decodeNodePayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);

export const decodeSubagentPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);

export const decodeProviderSessionPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);

export const decodeProviderThreadPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);

export const decodeProviderTurnPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);

export const decodeRuntimeRequestPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);

export const decodeMessagePayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);

export const decodePlanJson = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2PlanArtifactSchema),
);

export const decodeTurnItemPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);

export const decodeCheckpointScopePayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);

export const decodeCheckpointPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);

export const decodeContextHandoffPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);

export const decodeContextTransferPayload = Schema.decodeUnknownEffect(
Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

export const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);

export const isProjectionStoreReadError = Schema.is(ProjectionStoreReadError);

export function parseEncodedPayload(json: string): Record<string, unknown> {
return JSON.parse(json) as Record<string, unknown>;
}

export function stringField(payload: Record<string, unknown>, field: string): string {
const value = payload[field];
return typeof value === "string" ? value : String(value);
}

export function nullableStringField(payload: Record<string, unknown>, field: string): string | null {
const value = payload[field];
if (value === null || value === undefined) {
  return null;
}
return typeof value === "string" ? value : String(value);
}

export function booleanInt(value: boolean): 0 | 1 {
return value ? 1 : 0;
}

export const decodeRows =
<A, E>(decode: (json: string) => Effect.Effect<A, E>, threadId: ThreadId) =>
(rows: ReadonlyArray<PayloadRow>): Effect.Effect<Array<A>, ProjectionStoreReadError> =>
  Effect.forEach(rows, (row) => decode(row.payload_json)).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectionStoreReadError({
          threadId,
          cause,
        }),
    ),
  );

export function messageIdForTurnItem(item: OrchestrationV2TurnItem): string | null {
switch (item.type) {
  case "user_message":
  case "assistant_message":
    return item.messageId;
  default:
    return null;
}
}

export function sortMessagesByTurnItemOrder(
messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
messageOrdinals = new Map<string, number>(),
): Array<OrchestrationV2ConversationMessage> {
for (const turnItem of turnItems) {
  const messageId = messageIdForTurnItem(turnItem);
  if (messageId === null) {
    continue;
  }
  const existing = messageOrdinals.get(messageId);
  if (existing === undefined || turnItem.ordinal < existing) {
    messageOrdinals.set(messageId, turnItem.ordinal);
  }
}

return messages.toSorted((left, right) => {
  const leftOrdinal = messageOrdinals.get(left.id) ?? Number.MAX_SAFE_INTEGER;
  const rightOrdinal = messageOrdinals.get(right.id) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrdinal !== rightOrdinal) {
    return leftOrdinal - rightOrdinal;
  }

  const leftCreatedAt = DateTime.toEpochMillis(left.createdAt);
  const rightCreatedAt = DateTime.toEpochMillis(right.createdAt);
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }

  return left.id.localeCompare(right.id);
});
}

export function inheritedVisibleTurnItemsFromLocalItems(
items: ReadonlyArray<OrchestrationV2TurnItem>,
): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
return items.map((item) => ({
  visibility: "inherited" as const,
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
}));
}

export function renumberVisibleTurnItems(
rows: ReadonlyArray<Omit<OrchestrationV2ProjectedTurnItem, "position">>,
offset = 0,
): Array<OrchestrationV2ProjectedTurnItem> {
return rows.map((row, position) => ({ ...row, position: position + offset }));
}

export function makeForkMarkerTurnItem(input: {
readonly targetProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
readonly sourceThreadId: ThreadId;
readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Extract<OrchestrationV2TurnItem, { type: "fork" }> {
const createdAt = input.targetProjection.thread.createdAt;
return {
  id: TurnItemId.make(`turn-item:fork:${input.targetProjection.thread.id}`),
  threadId: input.targetProjection.thread.id,
  runId: null,
  nodeId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: "Forked from conversation",
  startedAt: null,
  completedAt: createdAt,
  updatedAt: createdAt,
  type: "fork",
  source: { type: "run", threadId: input.sourceThreadId, runId: input.sourceRunId },
  targetThreadId: input.targetProjection.thread.id,
};
}

export function isTurnItemAtOrBeforeRun(input: {
readonly historyOrigin: OrchestrationV2ThreadProjection["thread"]["historyOrigin"];
readonly itemRunId: OrchestrationV2TurnItem["runId"];
readonly runOrdinalById: ReadonlyMap<NonNullable<OrchestrationV2TurnItem["runId"]>, number>;
readonly sourceRunOrdinal: number;
}): boolean {
if (input.itemRunId === null) {
  return input.historyOrigin === "v1_import";
}
const ordinal = input.runOrdinalById.get(input.itemRunId);
return ordinal !== undefined && ordinal <= input.sourceRunOrdinal;
}

export function visibleTurnItemsThroughRun(input: {
readonly sourceProjection: OrchestrationV2ThreadProjection;
readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
const sourceRun = input.sourceProjection.runs.find((run) => run.id === input.sourceRunId);
if (sourceRun === undefined) {
  return [];
}

const runOrdinalById = new Map(input.sourceProjection.runs.map((run) => [run.id, run.ordinal]));
const inheritedPrefix = input.sourceProjection.visibleTurnItems
  .filter(
    (row) => row.item.threadId !== input.sourceProjection.thread.id || row.item.type === "fork",
  )
  .map((row) => ({
    visibility: "inherited" as const,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    item: row.item,
  }));
const localPrefix = inheritedVisibleTurnItemsFromLocalItems(
  input.sourceProjection.turnItems.filter((item) => {
    if (
      isOrchestrationV2SupersededInterrupt({
        item,
        attempts: input.sourceProjection.attempts,
        items: input.sourceProjection.turnItems,
      })
    ) {
      return false;
    }
    return isTurnItemAtOrBeforeRun({
      historyOrigin: input.sourceProjection.thread.historyOrigin,
      itemRunId: item.runId,
      runOrdinalById,
      sourceRunOrdinal: sourceRun.ordinal,
    });
  }),
);

return [...inheritedPrefix, ...localPrefix];
}

export function inheritedRunFork(thread: Pick<OrchestrationV2AppThread, "forkedFrom" | "lineage">) {
return thread.forkedFrom?.type === "run" && thread.lineage.sideChat !== true
  ? thread.forkedFrom
  : null;
}

export function buildVisibleTurnItems(input: {
readonly projection: OrchestrationV2ThreadProjection;
readonly sourceProjection: OrchestrationV2ThreadProjection | null;
readonly inheritedRowCount?: number;
}): Array<OrchestrationV2ProjectedTurnItem> {
const forkedFrom = inheritedRunFork(input.projection.thread);
if (
  forkedFrom === null ||
  (input.sourceProjection === null && input.inheritedRowCount === undefined)
) {
  return localVisibleTurnItems(input.projection);
}

const inherited =
  input.sourceProjection === null
    ? []
    : visibleTurnItemsThroughRun({
        sourceProjection: input.sourceProjection,
        sourceRunId: forkedFrom.runId,
      });
const markerItem = makeForkMarkerTurnItem({
  targetProjection: input.projection,
  sourceThreadId: forkedFrom.threadId,
  sourceRunId: forkedFrom.runId,
});
const local = activeLocalTurnItems(input.projection).map((row) => ({
  visibility: "local" as const,
  sourceThreadId: row.sourceThreadId,
  sourceItemId: row.sourceItemId,
  item: row.item,
}));

return renumberVisibleTurnItems(
  [
    ...inherited,
    {
      visibility: "synthetic",
      sourceThreadId: forkedFrom.threadId,
      sourceItemId: markerItem.id,
      item: markerItem,
    },
    ...local,
  ],
  input.inheritedRowCount ?? 0,
);
}

export function pendingRuntimeRequestSummary(
request: OrchestrationV2ThreadProjection["runtimeRequests"][number] | null,
): OrchestrationV2PendingRuntimeRequestSummary | null {
if (request === null) return null;
return {
  id: request.id,
  kind: request.kind,
  createdAt: request.createdAt,
  blocking: request.responseCapability.type !== "message",
};
}

export function secretRequestAsPendingInput(
item: OrchestrationV2TurnItem | null,
): OrchestrationV2PendingRuntimeRequestSummary | null {
if ((item?.type !== "secret_request" && item?.type !== "link_request") || item.nodeId === null)
  return null;
return {
  id: RuntimeRequestId.make(item.id),
  kind: "user_input",
  createdAt: item.startedAt ?? item.updatedAt,
  blocking: true,
};
}

export const waitsOnUser = (
item: OrchestrationV2TurnItem,
liveRunIds: ReadonlySet<RunId>,
latestUserAuthoredMessageAt: DateTime.Utc | null,
) =>
(item.type === "link_request" && linkCardStillAsks(item, latestUserAuthoredMessageAt)) ||
(item.type === "secret_request" && item.runId !== null && liveRunIds.has(item.runId));

export const linkCardStillAsks = (
item: OrchestrationV2TurnItem,
latestUserAuthoredMessageAt: DateTime.Utc | null,
) =>
latestUserAuthoredMessageAt === null ||
!DateTime.isGreaterThan(latestUserAuthoredMessageAt, item.startedAt ?? item.updatedAt);

export function providerInstanceHistoryForShell(input: {
readonly threadId: ThreadId;
readonly providerThreads: ReadonlyArray<
  OrchestrationV2ThreadProjection["providerThreads"][number]
>;
}): ReadonlyArray<ProviderInstanceId> {
const history: Array<ProviderInstanceId> = [];
for (const providerThread of input.providerThreads
  .filter((thread) => thread.appThreadId === input.threadId && thread.ownerNodeId === null)
  .toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
      left.id.localeCompare(right.id),
  )) {
  if (!history.includes(providerThread.providerInstanceId)) {
    history.push(providerThread.providerInstanceId);
  }
}
return history;
}

export function activeProviderGoalForShell(
providerThreads: ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>,
activeProviderThreadId: OrchestrationV2ThreadProjection["thread"]["activeProviderThreadId"],
): OrchestrationV2ThreadShell["goal"] {
return providerThreads.find((thread) => thread.id === activeProviderThreadId)?.goal ?? null;
}

export function isSilentRunForShell(
run: OrchestrationV2ThreadProjection["runs"][number],
projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
): boolean {
return (
  run.status !== "failed" &&
  projection.messages.some(
    (message) => message.id === run.userMessageId && idleCompactionOf(message) !== undefined,
  ) &&
  !projection.turnItems.some(
    (item) => item.runId === run.id && item.type === "compaction" && item.status === "failed",
  )
);
}

export function isInterruptibleRunForShell(run: OrchestrationV2ThreadProjection["runs"][number]): boolean {
return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

export type ShellActivityRunStatus = "preparing" | "running" | "starting" | "waiting";

export function isActivityRunForShell(
run: OrchestrationV2ThreadProjection["runs"][number],
): run is OrchestrationV2ThreadProjection["runs"][number] & {
readonly status: ShellActivityRunStatus;
} {
return isInterruptibleRunForShell(run) || run.status === "waiting";
}
