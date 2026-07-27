import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolExecutionState,
  type ToolLifecycleItemType,
  type ToolPresentation,
  type ProviderDriverKind,
  type RuntimeItemId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { deriveToolIdentityFromData } from "@t3tools/shared/toolIdentity";
import { deriveToolPresentation } from "@t3tools/shared/toolPresentation";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { isUsageLimitDetail } from "../../provider/UsageLimit.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const BUFFERED_REASONING_TEXT_BY_TURN_CACHE_CAPACITY = 10_000;
const BUFFERED_REASONING_TEXT_BY_TURN_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
/** Cap reasoning activity payload so a long Grok thought stream cannot bloat SQLite. */
const MAX_REASONING_ACTIVITY_CHARS = 8_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";
// tool.updated / task.progress / context-window.updated are full-snapshot
// latest-wins payloads that stream at token-ish rates. task.updated is a
// PARTIAL patch (only changed fields), so coalescing merges defined fields
// shallowly instead of replacing the whole payload. Each of these used to
// be its own command (SQLite txn + full subscriber fan-out); they are
// coalesced per (thread, row) and flushed on this cadence instead.
const ACTIVITY_COALESCE_FLUSH_INTERVAL = Duration.millis(200);

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    }
  | {
      // Periodic tick that drains the coalesced-activity buffer. Routed
      // through the worker queue so flushes serialize with event processing.
      source: "flush";
    };

/** A coalescible activity held back for the next flush. */
interface PendingActivity {
  readonly threadId: ThreadId;
  readonly activity: OrchestrationThreadActivity;
  readonly event: ProviderRuntimeEvent;
}

/**
 * Buffer key for activities that may collapse within a flush window.
 * Anything returning null dispatches immediately (and in order).
 */
function activityCoalesceKey(
  event: ProviderRuntimeEvent,
  activity: OrchestrationThreadActivity,
): string | null {
  switch (activity.kind) {
    case "tool.updated":
      return event.itemId ? `tool:${event.itemId}` : null;
    case "task.progress":
    case "task.updated": {
      const taskId = (activity.payload as { readonly taskId?: string } | undefined)?.taskId;
      return taskId ? `task:${activity.kind}:${taskId}` : null;
    }
    case "turn.reasoning":
      // One live reasoning row per turn; successive deltas replace in place.
      return event.turnId ? `reasoning:${event.turnId}` : `reasoning:${activity.id}`;
    case "context-compaction":
      // One row per compaction (stable activity id); started/completed/failed
      // states replace each other in place.
      return `compaction:${activity.id}`;
    case "context-window.updated":
      return `ctx:${event.turnId ?? "thread"}`;
    default:
      return null;
  }
}

/**
 * Merge a newly arrived coalescible activity into one already buffered.
 * Full-snapshot kinds (tool.updated, task.progress, context-window) are
 * latest-wins. task.updated is a partial patch — shallow-merge defined
 * fields so earlier patch keys are not silently dropped.
 */
function mergePendingActivity(existing: PendingActivity, next: PendingActivity): PendingActivity {
  if (existing.activity.kind !== "task.updated" || next.activity.kind !== "task.updated") {
    return next;
  }

  const existingPayload =
    existing.activity.payload && typeof existing.activity.payload === "object"
      ? (existing.activity.payload as Record<string, unknown>)
      : {};
  const nextPayload =
    next.activity.payload && typeof next.activity.payload === "object"
      ? (next.activity.payload as Record<string, unknown>)
      : {};

  return {
    threadId: next.threadId,
    event: next.event,
    activity: {
      ...next.activity,
      payload: {
        ...existingPayload,
        ...nextPayload,
      },
    },
  };
}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

const TURN_SCOPED_PROGRESS_EVENT_PREFIXES = [
  "turn.",
  "content.",
  "item.",
  "tool.",
  "task.",
] as const;

/**
 * Events that only occur while a turn is genuinely producing work. Turn
 * lifecycle edges are excluded — they drive the session status directly.
 */
function isTurnScopedProgressEvent(event: ProviderRuntimeEvent): boolean {
  if (
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted"
  ) {
    return false;
  }
  return TURN_SCOPED_PROGRESS_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix));
}

function hasAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
  options?: { readonly streamingOnly?: boolean; readonly completedOnly?: boolean },
): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant" || message.turnId !== turnId) {
      continue;
    }
    if (options?.streamingOnly === true && !message.streaming) {
      continue;
    }
    if (options?.completedOnly === true && message.streaming) {
      continue;
    }
    return true;
  }
  return false;
}

function findMessageById(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.id === messageId) {
      return message;
    }
  }
  return undefined;
}

function findProposedPlanById(
  proposedPlans: ReadonlyArray<
    Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  >,
  planId: string,
):
  | Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  | undefined {
  for (let index = 0; index < proposedPlans.length; index += 1) {
    const proposedPlan = proposedPlans[index];
    if (proposedPlan?.id === planId) {
      return proposedPlan;
    }
  }
  return undefined;
}

function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number {
  let maxTurnCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }
  return maxTurnCount;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

/**
 * Attach the canonical tool identity (MCP server/tool, skill, computer use) to
 * a tool activity's `data` so every client can render the call natively —
 * icon and title — without re-parsing provider-shaped tool names itself.
 * Derived here rather than per adapter so all providers get it.
 */
function withToolIdentity(data: unknown): Record<string, unknown> | undefined {
  const identity = deriveToolIdentityFromData(data);
  if (!identity) {
    return undefined;
  }
  const record =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return { ...record, tool: identity };
}

/**
 * Stamp the runtime item id onto a tool activity's `data` as `toolCallId` so
 * every lifecycle event of one invocation carries the same correlation key.
 * Clients upsert their tool row by it; without one they fall back to the
 * per-event activity id and the started/updated row is never replaced by the
 * completion — the call renders twice, and the first row stays "running" with
 * a live timer forever. ACP adapters already put their own `toolCallId` in
 * `data`; theirs wins so the wire value stays the agent's own id.
 */
function withToolCallId(data: unknown, itemId: RuntimeItemId | undefined): unknown {
  if (itemId === undefined) {
    return data;
  }
  if (data === undefined || data === null) {
    return { toolCallId: itemId };
  }
  if (typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const existing = record["toolCallId"];
    if (typeof existing === "string" && existing.trim().length > 0) {
      return record;
    }
    return { ...record, toolCallId: itemId };
  }
  // `data` is typed `unknown` on the wire, so an adapter may send a scalar or
  // an array. Clients resolve it through a record lookup and ignore anything
  // that is not one, so nothing reads such a payload today — but leaving it
  // alone would leave the call uncorrelated, which is exactly the duplicate
  // row this stamping exists to prevent. It moves under `value` instead of
  // being dropped.
  return { toolCallId: itemId, value: data };
}

function toolActivityData(
  data: unknown,
  itemId: RuntimeItemId | undefined,
): { data: unknown } | Record<string, never> {
  const stamped = withToolCallId(withToolIdentity(data) ?? data, itemId);
  return stamped !== undefined ? { data: stamped } : {};
}

/**
 * Normalizes a tool lifecycle item into the typed native presentation clients
 * render (contracts `ToolPresentation`). Derived here, once, so skills,
 * plugins, MCP tools, and unknown tools reach every client already typed
 * instead of each app re-scraping the provider-specific `data` bag.
 */
function toolPresentationOf(
  itemType: ToolLifecycleItemType,
  payload: {
    readonly status?: string | undefined;
    readonly title?: string | undefined;
    readonly detail?: string | undefined;
    readonly data?: unknown;
  },
  provider: ProviderDriverKind,
  fallbackState: ToolExecutionState,
): ToolPresentation {
  return deriveToolPresentation({
    itemType,
    provider,
    fallbackState,
    ...(payload.status !== undefined ? { status: payload.status } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
    ...(payload.data !== undefined ? { data: payload.data } : {}),
  });
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function hasRenderableAssistantContentForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.turnId === turnId &&
      hasRenderableAssistantText(message.text)
    ) {
      return true;
    }
  }
  return false;
}

function countToolActivitiesForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId,
): number {
  // Prefer completed tool rows; fall back to started when a turn ends mid-call.
  let completed = 0;
  let started = 0;
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index];
    if (!activity || activity.turnId !== turnId) {
      continue;
    }
    if (activity.kind === "tool.completed") {
      completed += 1;
    } else if (activity.kind === "tool.started") {
      started += 1;
    }
  }
  return completed > 0 ? completed : started;
}

function fallbackCompletionText(input: {
  readonly turnState: "completed" | "failed" | "interrupted" | "cancelled";
  readonly stopReason: string | null | undefined;
  readonly errorMessage: string | undefined;
  readonly toolCallCount: number;
}): string {
  const { turnState, stopReason, errorMessage, toolCallCount } = input;
  if (turnState === "failed") {
    return `Task failed: ${errorMessage?.trim() || "Turn failed"}`;
  }
  if (turnState === "cancelled" || turnState === "interrupted") {
    return toolCallCount > 0
      ? `Task cancelled after executing ${toolCallCount} tool(s).`
      : "Task cancelled.";
  }
  if (stopReason === "max_tokens") {
    return "Response truncated due to length limit.";
  }
  if (toolCallCount > 0) {
    return `Completed task (executed ${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}).`;
  }
  return "Task completed.";
}

function reasoningActivityId(threadId: ThreadId, turnId: TurnId | undefined): EventId {
  return EventId.make(
    turnId !== undefined ? `reasoning:${threadId}:${turnId}` : `reasoning:${threadId}:no-turn`,
  );
}

function eventSequenceOf(
  event: ProviderRuntimeEvent,
): { readonly sequence: number } | Record<string, never> {
  const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
  return eventWithSequence.sessionSequence !== undefined
    ? { sequence: eventWithSequence.sessionSequence }
    : {};
}

/**
 * Stable activity id for a compaction row so started / completed / failed /
 * canceled states replace each other in place (the projector upserts
 * activities by id) even across coalesce flushes.
 */
function compactionActivityId(
  threadId: ThreadId,
  turnId: TurnId | undefined,
  itemId: RuntimeItemId | undefined,
  eventId: EventId,
): EventId {
  return EventId.make(`compaction:${threadId}:${turnId ?? itemId ?? eventId}`);
}

function isCompactionItemLifecycleEvent(
  event: ProviderRuntimeEvent,
): event is Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
> {
  return (
    (event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed") &&
    event.payload.itemType === "context_compaction"
  );
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}
function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function parseWaitingState(detail: unknown):
  | {
      readonly reason: "scheduled-wakeup" | "dependency";
      readonly target:
        | { readonly kind: "time"; readonly at: string }
        | { readonly kind: "event"; readonly event: string };
      readonly outcome?: "missed" | "cancelled";
    }
  | undefined {
  if (detail === null || typeof detail !== "object") return undefined;
  const value = detail as Record<string, unknown>;
  const reason = value.reason === "dependency" ? "dependency" : "scheduled-wakeup";
  const outcome =
    value.outcome === "cancelled" || value.status === "cancelled"
      ? "cancelled"
      : value.outcome === "missed" || value.status === "missed"
        ? "missed"
        : undefined;
  if (typeof value.at === "string" && Number.isFinite(Date.parse(value.at))) {
    return { reason, target: { kind: "time", at: value.at }, ...(outcome ? { outcome } : {}) };
  }
  if (typeof value.event === "string" && value.event.trim().length > 0) {
    return {
      reason,
      target: { kind: "event", event: value.event.trim() },
      ...(outcome ? { outcome } : {}),
    };
  }
  return undefined;
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

function isProcessStderrRuntimeDetail(value: unknown): boolean {
  return (
    value !== undefined &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly surface?: unknown }).surface === "process/stderr"
  );
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = eventSequenceOf(event);
  switch (event.type) {
    case "session.health": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.state === "stalled" ? "error" : "info",
          kind: "session.health",
          summary:
            event.payload.state === "stalled"
              ? "Provider turn appears stalled"
              : "Provider turn activity recovered",
          payload: event.payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "session.exited": {
      // Only surface non-graceful exits with meaningful stderr. The tail rides
      // the client activity flow so the mac can render an expandable "process
      // output" disclosure on the failing turn.
      const stderrTail = event.payload.stderrTail;
      if (
        event.payload.exitKind === "graceful" ||
        stderrTail === undefined ||
        stderrTail.trim().length === 0
      ) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "session.exited",
          summary: event.payload.reason ?? "Provider process exited",
          payload: {
            stderrTail,
            ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
            ...(event.payload.exitKind !== undefined ? { exitKind: event.payload.exitKind } : {}),
            ...(event.payload.recoverable !== undefined
              ? { recoverable: event.payload.recoverable }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      const usageLimit = isUsageLimitDetail(event.payload.detail)
        ? event.payload.detail
        : undefined;
      if (usageLimit !== undefined) {
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "error",
            kind: "usage-limit.reached",
            summary: "Usage limit reached",
            payload: {
              message: truncateDetail(event.payload.message),
              provider: usageLimit.provider ?? event.provider,
              source: usageLimit.source,
              ...(usageLimit.resetsAt !== undefined ? { resetsAt: usageLimit.resetsAt } : {}),
              ...(usageLimit.resetsAtEpochSeconds !== undefined
                ? { resetsAtEpochSeconds: usageLimit.resetsAtEpochSeconds }
                : {}),
              ...(usageLimit.resetSource !== undefined
                ? { resetSource: usageLimit.resetSource }
                : {}),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(isProcessStderrRuntimeDetail(event.payload.detail)
              ? { source: "process/stderr" }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.denied": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          // Use the adapter-supplied message as the row label so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(isProcessStderrRuntimeDetail(event.payload.detail)
              ? { source: "process/stderr" }
              : {}),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.entityType ? { entityType: event.payload.entityType } : {}),
            ...(event.payload.model ? { model: event.payload.model } : {}),
            ...(event.payload.effort ? { effort: event.payload.effort } : {}),
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
            ...(event.payload.workflowName ? { workflowName: event.payload.workflowName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.description
              ? {
                  description: truncateDetail(event.payload.description),
                  detail: truncateDetail(event.payload.description),
                }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      // Streamed progress (background command output) carries only a summary;
      // a task that restates its description contributes it too.
      const progressDetail = event.payload.summary ?? event.payload.description;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.entityType ? { entityType: event.payload.entityType } : {}),
            ...(progressDetail ? { detail: truncateDetail(progressDetail) } : {}),
            ...(event.payload.description
              ? { description: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.updated": {
      const status = event.payload.status;
      const terminal = status === "completed" || status === "failed" || status === "killed";
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary: terminal
            ? status === "failed"
              ? "Task failed"
              : status === "killed"
                ? "Task stopped"
                : "Task completed"
            : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.entityType ? { entityType: event.payload.entityType } : {}),
            ...(status ? { status } : {}),
            ...(event.payload.model ? { model: event.payload.model } : {}),
            ...(event.payload.description
              ? {
                  description: truncateDetail(event.payload.description),
                  detail: truncateDetail(event.payload.description),
                }
              : {}),
            ...(event.payload.error ? { error: truncateDetail(event.payload.error) } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...(event.payload.endTime !== undefined ? { endTime: event.payload.endTime } : {}),
            ...(event.payload.totalPausedMs !== undefined
              ? { totalPausedMs: event.payload.totalPausedMs }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.entityType ? { entityType: event.payload.entityType } : {}),
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.outputFile ? { outputFile: event.payload.outputFile } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      // Compaction completion is handled by the state-aware mapper in
      // processRuntimeEvent (compactionActivityForEvent), which is idempotent
      // with item-based compaction completions.
      return [];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...toolActivityData(event.payload.data, event.itemId),
            presentation: toolPresentationOf(
              event.payload.itemType,
              event.payload,
              event.provider,
              "running",
            ),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...toolActivityData(event.payload.data, event.itemId),
            presentation: toolPresentationOf(
              event.payload.itemType,
              event.payload,
              event.provider,
              "succeeded",
            ),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const startedToolIdentity = deriveToolIdentityFromData(event.payload.data);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            // Identity only: the started row needs the icon/name, not the
            // input — but it still carries the correlation id so a client
            // that renders started rows folds the completion into this one.
            ...toolActivityData(
              startedToolIdentity ? { tool: startedToolIdentity } : undefined,
              event.itemId,
            ),
            presentation: toolPresentationOf(
              event.payload.itemType,
              event.payload,
              event.provider,
              "running",
            ),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const providerCommandId = (event: ProviderRuntimeEvent, tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`provider:${event.eventId}:${tag}:${uuid}`)),
    );

  // Coalesced latest-wins activities awaiting flush, keyed thread → row.
  // Only ever touched from the single worker fiber (event processing and
  // flush ticks both go through the worker queue), so a plain Map is safe.
  const pendingActivities = new Map<ThreadId, Map<string, PendingActivity>>();

  const dispatchActivity = (pending: PendingActivity) =>
    providerCommandId(pending.event, "thread-activity-append").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: pending.threadId,
          activity: pending.activity,
          createdAt: pending.activity.createdAt,
        }),
      ),
      Effect.asVoid,
    );

  const flushPendingActivities = (threadId?: ThreadId) =>
    Effect.gen(function* () {
      const threadIds = threadId !== undefined ? [threadId] : [...pendingActivities.keys()];
      for (const id of threadIds) {
        const entries = pendingActivities.get(id);
        if (!entries) continue;
        pendingActivities.delete(id);
        for (const pending of entries.values()) {
          yield* dispatchActivity(pending);
        }
      }
    });

  /**
   * Buffer a coalescible activity (replacing the pending row in place) or
   * flush-then-dispatch an immediate one. Shared by the generic activity
   * mapper and the compaction lifecycle mapper.
   */
  const queueActivity = (
    threadId: ThreadId,
    event: ProviderRuntimeEvent,
    activity: OrchestrationThreadActivity,
  ) =>
    Effect.gen(function* () {
      const pendingKey = activityCoalesceKey(event, activity);
      if (pendingKey !== null) {
        const threadPending = pendingActivities.get(threadId) ?? new Map<string, PendingActivity>();
        const incoming: PendingActivity = { threadId, activity, event };
        const existing = threadPending.get(pendingKey);
        threadPending.set(
          pendingKey,
          existing !== undefined ? mergePendingActivity(existing, incoming) : incoming,
        );
        pendingActivities.set(threadId, threadPending);
        return;
      }
      // Any immediate row flushes the thread's buffer first so the work
      // log keeps arrival order — only consecutive progress snapshots for
      // the same row ever collapse.
      yield* flushPendingActivities(threadId);
      yield* dispatchActivity({ threadId, activity, event });
    });

  /**
   * In-flight compaction per (thread, turn). "completed" means a terminal row
   * (completed / failed / canceled) was already emitted, so fallback and
   * synthesized completions stay idempotent. Entries are pruned when the turn
   * ends and on session exit. Only touched from the single worker fiber.
   */
  interface CompactionTurnState {
    readonly status: "started" | "completed";
    readonly activityId: EventId;
    readonly turnId: TurnId | null;
  }
  const compactionStateByTurnKey = new Map<string, CompactionTurnState>();

  const compactionTurnKey = (threadId: ThreadId, turnId: TurnId | undefined) =>
    turnId !== undefined ? providerTurnKey(threadId, turnId) : `${threadId}:no-turn`;

  const COMPACTION_INCOMPLETE_DETAIL =
    "Compaction did not finish — the session context is unchanged. Start a new thread or retry.";

  /**
   * State-aware mapper for compaction lifecycle events (`context_compaction`
   * item lifecycle + the `thread.state.changed { compacted }` fallback).
   * Returns the activity to queue, or undefined when the event is not
   * compaction-related or is an idempotent duplicate.
   */
  const compactionActivityForEvent = (
    event: ProviderRuntimeEvent,
  ): OrchestrationThreadActivity | undefined => {
    const turnId = toTurnId(event.turnId);
    const key = compactionTurnKey(event.threadId, turnId);
    const existing = compactionStateByTurnKey.get(key);
    const activityId = compactionActivityId(event.threadId, turnId, event.itemId, event.eventId);
    const base = {
      id: activityId,
      createdAt: event.createdAt,
      kind: "context-compaction",
      turnId: turnId ?? null,
      ...eventSequenceOf(event),
    } as const;

    if (isCompactionItemLifecycleEvent(event)) {
      if (event.type === "item.completed") {
        compactionStateByTurnKey.set(key, {
          status: "completed",
          activityId,
          turnId: turnId ?? null,
        });
        return {
          ...base,
          tone: "info",
          summary: "Context compacted",
          payload: {
            status: "completed",
            ...(event.payload.usedTokensBefore !== undefined
              ? { usedTokensBefore: event.payload.usedTokensBefore }
              : {}),
            ...(event.payload.usedTokensAfter !== undefined
              ? { usedTokensAfter: event.payload.usedTokensAfter }
              : {}),
            ...(event.payload.maxTokens !== undefined
              ? { maxTokens: event.payload.maxTokens }
              : {}),
          },
        };
      }
      // item.started / item.updated — (re)arm the in-progress compaction.
      compactionStateByTurnKey.set(key, { status: "started", activityId, turnId: turnId ?? null });
      return {
        ...base,
        tone: "info",
        summary: "Compacting context…",
        payload: { status: "started" },
      };
    }

    if (event.type === "thread.state.changed" && event.payload.state === "compacted") {
      // Fallback completion for providers that only emit a thread-level
      // compacted notification. Skip when an item-based completion already
      // produced the terminal row for this turn.
      if (existing?.status === "completed") {
        return undefined;
      }
      compactionStateByTurnKey.set(key, {
        status: "completed",
        activityId,
        turnId: turnId ?? null,
      });
      return {
        ...base,
        tone: "info",
        summary: "Context compacted",
        payload: { status: "completed" },
      };
    }

    return undefined;
  };

  /**
   * Synthesize a terminal compaction row when the turn fails / is interrupted
   * (or a runtime error arrives) while a compaction is still in progress.
   * Marks the compaction terminal so later signals stay idempotent.
   */
  const synthesizeCompactionTerminalActivity = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly turnId: TurnId | undefined;
    readonly status: "failed" | "canceled";
  }): OrchestrationThreadActivity | undefined => {
    const key = (() => {
      if (input.turnId !== undefined) {
        const direct = compactionTurnKey(input.threadId, input.turnId);
        if (compactionStateByTurnKey.get(direct)?.status === "started") {
          return direct;
        }
      }
      for (const [candidate, state] of compactionStateByTurnKey) {
        if (candidate.startsWith(`${input.threadId}:`) && state.status === "started") {
          return candidate;
        }
      }
      return undefined;
    })();
    if (key === undefined) {
      return undefined;
    }
    const state = compactionStateByTurnKey.get(key);
    if (state === undefined) {
      return undefined;
    }
    compactionStateByTurnKey.set(key, { ...state, status: "completed" });
    return {
      id: state.activityId,
      createdAt: input.event.createdAt,
      tone: "error",
      kind: "context-compaction",
      summary:
        input.status === "failed" ? "Context compaction failed" : "Context compaction canceled",
      payload: {
        status: input.status,
        detail: COMPACTION_INCOMPLETE_DETAIL,
      },
      turnId: state.turnId,
      ...eventSequenceOf(input.event),
    };
  };

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  /**
   * Every assistant message id already taken for a thread: hydrated once from
   * the projection (covers ids minted before a server restart), then kept
   * current as ids are claimed and finalized. Provider item ids are not
   * guaranteed unique across turns — e.g. the ACP session runtime derives
   * them from the session id plus a segment counter that resets on resume —
   * so without this guard a later turn can reuse an earlier message's id,
   * which makes the projector (and every client) append the new response
   * into the old message instead of showing it as a new one.
   */
  const usedAssistantMessageIdsByThread = yield* Cache.make<ThreadId, Set<string>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("used assistant message ids should be read through getUsedAssistantMessageIds"),
      ),
  });

  /**
   * The subset of used ids whose message has not finalized yet, hydrated
   * once from the projection (assistant messages still marked streaming) so
   * correlations built before a server restart survive it, then kept current
   * as ids are claimed and retired. A base-key correlation is only valid
   * while its id is in this set; a missing id means the provider recycled
   * the key.
   */
  const liveAssistantMessageIdsByThread = yield* Cache.make<ThreadId, Set<string>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("live assistant message ids should be read through getLiveAssistantMessageIds"),
      ),
  });

  /**
   * Correlation from a provider event's base key (itemId/turnId/eventId) to
   * the (possibly collision-adjusted) message id minted for it. Written for
   * turn-less delta mints and for every turn-scoped segment start, so the
   * completion path resolves the same id the deltas used whenever per-turn
   * segment state is absent (turn-less events, or state dropped early). The
   * completion path only trusts an entry while the message it names is still
   * live — a finalized message means the provider recycled the base key.
   */
  const claimedAssistantMessageIdByBaseKey = yield* Cache.make<string, MessageId>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(new Error("claimed assistant message ids are read through getOption only")),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  /** Accumulated reasoning_text / reasoning_summary_text per turn for live activity rows. */
  const bufferedReasoningTextByTurnKey = yield* Cache.make<string, string>({
    capacity: BUFFERED_REASONING_TEXT_BY_TURN_CACHE_CAPACITY,
    timeToLive: BUFFERED_REASONING_TEXT_BY_TURN_TTL,
    lookup: () => Effect.succeed(""),
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadShell = Effect.fn("resolveThreadShell")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const getUsedAssistantMessageIds = (threadId: ThreadId) =>
    Cache.getOption(usedAssistantMessageIdsByThread, threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            resolveThreadDetail(threadId).pipe(
              Effect.flatMap((detail) => {
                const ids = new Set<string>();
                for (const message of detail?.messages ?? []) {
                  if (message.role === "assistant") {
                    ids.add(message.id);
                  }
                }
                return Cache.set(usedAssistantMessageIdsByThread, threadId, ids).pipe(
                  Effect.as(ids),
                );
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  /**
   * Return `candidateId`, or the first free `${candidateId}:again:N` variant
   * when the candidate already belongs to an earlier message, and mark it
   * taken. Keeps every assistant message id unique per thread even when a
   * provider recycles item ids across turns.
   */
  const claimAssistantMessageId = (input: { threadId: ThreadId; candidateId: MessageId }) =>
    Effect.gen(function* () {
      const used = yield* getUsedAssistantMessageIds(input.threadId);
      let id = input.candidateId as string;
      let suffix = 0;
      while (used.has(id)) {
        suffix += 1;
        id = `${input.candidateId}:again:${suffix}`;
      }
      used.add(id);
      yield* Cache.set(usedAssistantMessageIdsByThread, input.threadId, used);
      const live = yield* getLiveAssistantMessageIds(input.threadId);
      live.add(id);
      yield* Cache.set(liveAssistantMessageIdsByThread, input.threadId, live);
      return MessageId.make(id);
    });

  const retireAssistantMessageId = (threadId: ThreadId, messageId: MessageId) =>
    Effect.gen(function* () {
      const used = yield* getUsedAssistantMessageIds(threadId);
      used.add(messageId);
      yield* Cache.set(usedAssistantMessageIdsByThread, threadId, used);
      const live = yield* getLiveAssistantMessageIds(threadId);
      live.delete(messageId);
      yield* Cache.set(liveAssistantMessageIdsByThread, threadId, live);
    });

  const getLiveAssistantMessageIds = (threadId: ThreadId) =>
    Cache.getOption(liveAssistantMessageIdsByThread, threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            resolveThreadDetail(threadId).pipe(
              Effect.flatMap((detail) => {
                const ids = new Set<string>();
                for (const message of detail?.messages ?? []) {
                  if (message.role === "assistant" && message.streaming) {
                    ids.add(message.id);
                  }
                }
                return Cache.set(liveAssistantMessageIdsByThread, threadId, ids).pipe(
                  Effect.as(ids),
                );
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const claimedBaseKeyCacheKey = (threadId: ThreadId, baseKey: string) => `${threadId}:${baseKey}`;

  const claimedAssistantMessageIdForBaseKey = (input: { threadId: ThreadId; baseKey: string }) =>
    Cache.getOption(
      claimedAssistantMessageIdByBaseKey,
      claimedBaseKeyCacheKey(input.threadId, input.baseKey),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.gen(function* () {
              const candidateId = assistantSegmentMessageId(input.baseKey, 0);
              const liveIds = yield* getLiveAssistantMessageIds(input.threadId);
              // Continue a live message with this id (e.g. projected before
              // a server restart) instead of forking a new one.
              const messageId = liveIds.has(candidateId)
                ? candidateId
                : yield* claimAssistantMessageId({
                    threadId: input.threadId,
                    candidateId,
                  });
              yield* Cache.set(
                claimedAssistantMessageIdByBaseKey,
                claimedBaseKeyCacheKey(input.threadId, input.baseKey),
                messageId,
              );
              return messageId;
            }),
          onSome: (cachedId) =>
            Effect.gen(function* () {
              const live = yield* getLiveAssistantMessageIds(input.threadId);
              if (live.has(cachedId)) {
                return cachedId;
              }
              // The message this base key pointed at already finalized: the
              // provider recycled the key for a new message, so mint a fresh
              // id and re-point the correlation instead of gluing into the
              // old message.
              const freshId = yield* claimAssistantMessageId({
                threadId: input.threadId,
                candidateId: assistantSegmentMessageId(input.baseKey, 0),
              });
              yield* Cache.set(
                claimedAssistantMessageIdByBaseKey,
                claimedBaseKeyCacheKey(input.threadId, input.baseKey),
                freshId,
              );
              return freshId;
            }),
        }),
      ),
    );

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
  ) => Cache.set(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId), state);

  const clearAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const getActiveAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantSegmentStateForTurn(threadId, turnId).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  /**
   * True when `messageId` names a still-streaming projection message that
   * belongs to this turn (or to no turn). A live message from a *different*
   * turn means the provider recycled the id — that is a collision, not a
   * continuation.
   */
  const liveMessageMatchesTurn = (threadId: ThreadId, messageId: MessageId, turnId: TurnId) =>
    resolveThreadDetail(threadId).pipe(
      Effect.map((detail) => {
        const message = detail?.messages.find((entry) => entry.id === messageId);
        return (
          message?.streaming === true && (message.turnId === null || message.turnId === turnId)
        );
      }),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
  }) =>
    getAssistantSegmentStateForTurn(input.threadId, input.turnId).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0),
            }),
            onSome: (state) => {
              const segmentIndex = state.baseKey === input.baseKey ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: state.baseKey === input.baseKey ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          const candidateMessageId = nextState.activeMessageId!;
          // A candidate that still names a live message of this same turn
          // (e.g. projected before a server restart) is a continuation, not
          // a collision — keep it instead of forking a new id.
          const continueLiveMessage =
            (yield* getLiveAssistantMessageIds(input.threadId)).has(candidateMessageId) &&
            (yield* liveMessageMatchesTurn(input.threadId, candidateMessageId, input.turnId));
          const claimedMessageId = continueLiveMessage
            ? candidateMessageId
            : yield* claimAssistantMessageId({
                threadId: input.threadId,
                candidateId: candidateMessageId,
              });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
            ...nextState,
            activeMessageId: claimedMessageId,
          });
          yield* Cache.set(
            claimedAssistantMessageIdByBaseKey,
            claimedBaseKeyCacheKey(input.threadId, input.baseKey),
            claimedMessageId,
          );
          return claimedMessageId;
        }),
      ),
    );

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return yield* claimedAssistantMessageIdForBaseKey({
          threadId: input.threadId,
          baseKey: assistantSegmentBaseKeyFromEvent(input.event),
        });
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const appendBufferedReasoningText = (
    threadId: ThreadId,
    turnId: TurnId | undefined,
    delta: string,
  ) => {
    const key = turnId !== undefined ? providerTurnKey(threadId, turnId) : `${threadId}:no-turn`;
    return Cache.getOption(bufferedReasoningTextByTurnKey, key).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          // Keep the latest window when the stream exceeds the activity cap.
          const stored =
            nextText.length <= MAX_REASONING_ACTIVITY_CHARS
              ? nextText
              : nextText.slice(nextText.length - MAX_REASONING_ACTIVITY_CHARS);
          yield* Cache.set(bufferedReasoningTextByTurnKey, key, stored);
          return stored;
        }),
      ),
    );
  };

  const clearBufferedReasoningText = (threadId: ThreadId, turnId: TurnId | undefined) => {
    const key = turnId !== undefined ? providerTurnKey(threadId, turnId) : `${threadId}:no-turn`;
    return Cache.invalidate(bufferedReasoningTextByTurnKey, key);
  };

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const generateFallbackCompletionMessage = (input: {
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
    threadId: ThreadId;
    turnId: TurnId;
    detailedThread: OrchestrationThread | null;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const turnState = normalizeRuntimeTurnState(input.event.payload.state);
      const stopReason = input.event.payload.stopReason;
      const errorMessage = input.event.payload.errorMessage;
      const toolCallCount = countToolActivitiesForTurn(
        input.detailedThread?.activities ?? [],
        input.turnId,
      );
      const fallbackText = fallbackCompletionText({
        turnState,
        stopReason,
        errorMessage,
        toolCallCount,
      });

      const messageId = MessageId.make(`assistant:fallback:${input.turnId}`);
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: yield* providerCommandId(input.event, "fallback-completion-message"),
        threadId: input.threadId,
        messageId,
        delta: fallbackText,
        turnId: input.turnId,
        createdAt: input.createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: yield* providerCommandId(input.event, "fallback-completion-finalize"),
        threadId: input.threadId,
        messageId,
        turnId: input.turnId,
        createdAt: input.createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* providerCommandId(input.event, "fallback-message-activity"),
        threadId: input.threadId,
        createdAt: input.createdAt,
        activity: {
          id: EventId.make(`fallback:${input.turnId}`),
          tone: "info",
          kind: "task.completed",
          summary: "Generated completion summary",
          payload: {
            detail:
              "No assistant text was received from provider; generated summary based on tool activity.",
            toolCallCount,
            ...(stopReason !== undefined && stopReason !== null ? { stopReason } : {}),
          },
          turnId: input.turnId,
          createdAt: input.createdAt,
        },
      });
      yield* Effect.logInfo("Generated fallback completion message", {
        threadId: input.threadId,
        turnId: input.turnId,
        provider: input.event.provider,
        stopReason,
        toolCallCount,
      });
    });

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: yield* providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    hasProjectedMessage?: boolean;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";
      const hasRenderableText = hasRenderableAssistantText(text);

      if (hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: yield* providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      if (input.hasProjectedMessage || hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* providerCommandId(input.event, input.commandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
        // Only retire once a complete actually went out. A completion that
        // dispatched nothing (no text, no projected message) must leave the
        // claimed id live so misordered later events for the same item still
        // correlate to it instead of minting another id.
        yield* retireAssistantMessageId(input.threadId, input.messageId);
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveAssistantSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage:
          input.hasProjectedMessage ||
          (input.flushedMessageIds?.has(activeMessageId.value) ?? false),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
          ...state.value,
          activeMessageId: null,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = findProposedPlanById(input.threadProposedPlans, input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: yield* providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const reasoningKeys = Array.from(yield* Cache.keys(bufferedReasoningTextByTurnKey));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        reasoningKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(bufferedReasoningTextByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      for (const key of compactionStateByTurnKey.keys()) {
        if (key.startsWith(prefix)) {
          compactionStateByTurnKey.delete(key);
        }
      }
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const sourceThread = yield* resolveThreadDetail(sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      const commandUuid = yield* crypto.randomUUIDv4;
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${commandUuid}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadShell(event.threadId);
      if (!thread) return;

      let loadedThreadDetail: OrchestrationThread | null | undefined;
      const getLoadedThreadDetail = () =>
        Effect.gen(function* () {
          if (loadedThreadDetail !== undefined) {
            return loadedThreadDetail;
          }
          loadedThreadDetail = (yield* resolveThreadDetail(thread.id)) ?? null;
          return loadedThreadDetail;
        });

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      // A turn.started that conflicts with the tracked active turn is
      // legitimate when the provider session itself already tracks the
      // event's turn as its active turn: steering a running turn — or a
      // provider opening a follow-up turn on its own (queued messages,
      // continuations) — makes providers open a new turn without ever
      // completing the superseded one. A stale turn.started for some other
      // turn id still gets rejected, because the provider no longer reports
      // that turn as active.
      const conflictingTurnStartIsProviderActive =
        event.type === "turn.started" && conflictsWithActiveTurn
          ? sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId)
          : false;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn || conflictingTurnStartIsProviderActive;
          case "turn.completed":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const waiting =
          event.type === "session.state.changed" && event.payload.state === "waiting"
            ? parseWaitingState(event.payload.detail)
            : undefined;
        const effectiveStatus =
          status === "waiting" && waiting === undefined
            ? "running"
            : status === "waiting" && waiting?.outcome === "cancelled"
              ? "ready"
              : status;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: effectiveStatus,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              ...(waiting !== undefined ? { waiting } : {}),
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      // When the provider streams progress for a turn the projection no
      // longer tracks as active (e.g. its turn.started was rejected by the
      // lifecycle guard, or a premature turn.completed flipped the session to
      // ready while work continued), restore the running status — but only
      // when the provider session itself still reports that turn as active,
      // so late flushes from settled turns cannot resurrect stale work.
      if (
        eventTurnId !== undefined &&
        activeTurnId === null &&
        isTurnScopedProgressEvent(event) &&
        (thread.session?.status === "idle" || thread.session?.status === "ready") &&
        sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId)
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: yield* providerCommandId(event, "thread-session-restore-running"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: event.provider,
            ...(event.providerInstanceId !== undefined
              ? { providerInstanceId: event.providerInstanceId }
              : {}),
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: eventTurnId,
            lastError: thread.session?.lastError ?? null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const reasoningDelta =
        event.type === "content.delta" &&
        (event.payload.streamKind === "reasoning_text" ||
          event.payload.streamKind === "reasoning_summary_text")
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      // A new assistant item starting while its message id is still open is
      // the provider's explicit generation boundary: the id was recycled, so
      // close the previous message cleanly before the new item's deltas fork
      // to a fresh id.
      if (event.type === "item.started" && event.payload.itemType === "assistant_message") {
        const candidateMessageId = assistantSegmentMessageId(
          assistantSegmentBaseKeyFromEvent(event),
          0,
        );
        const liveIds = yield* getLiveAssistantMessageIds(thread.id);
        if (liveIds.has(candidateMessageId)) {
          const detailedThread = yield* getLoadedThreadDetail();
          const startTurnId = toTurnId(event.turnId);
          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: candidateMessageId,
            ...(startTurnId ? { turnId: startTurnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete-on-recycled-item-start",
            finalDeltaCommandTag: "assistant-delta-finalize-on-recycled-item-start",
            hasProjectedMessage:
              detailedThread !== null &&
              findMessageById(detailedThread.messages, candidateMessageId) !== undefined,
          });
        }
      }

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
        );
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: yield* providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      if (reasoningDelta && reasoningDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const accumulated = yield* appendBufferedReasoningText(thread.id, turnId, reasoningDelta);
        // Project as a coalesced activity so mac/mobile can show live thinking
        // without inventing a new orchestration message role.
        const reasoningActivity: OrchestrationThreadActivity = {
          id: reasoningActivityId(thread.id, turnId),
          createdAt: now,
          tone: "info",
          kind: "turn.reasoning",
          summary: "Reasoning",
          payload: {
            detail: accumulated,
            streamKind:
              event.type === "content.delta" ? event.payload.streamKind : "reasoning_text",
          },
          turnId: turnId ?? null,
        };
        const pendingKey = activityCoalesceKey(event, reasoningActivity);
        if (pendingKey !== null) {
          const threadPending =
            pendingActivities.get(thread.id) ?? new Map<string, PendingActivity>();
          const incoming: PendingActivity = {
            threadId: thread.id,
            activity: reasoningActivity,
            event,
          };
          const existing = threadPending.get(pendingKey);
          threadPending.set(
            pendingKey,
            existing !== undefined ? mergePendingActivity(existing, incoming) : incoming,
          );
          pendingActivities.set(thread.id, threadPending);
        } else {
          yield* flushPendingActivities(thread.id);
          yield* dispatchActivity({
            threadId: thread.id,
            activity: reasoningActivity,
            event,
          });
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const detailedThread = yield* getLoadedThreadDetail();
        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
        );
        const flushedMessageIds =
          assistantDeliveryMode === "buffered"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();
        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage:
            detailedThread !== null &&
            hasAssistantMessageForTurn(detailedThread.messages, pauseForUserTurnId, {
              streamingOnly: true,
            }),
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const turnId = toTurnId(event.turnId);
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const hasCompletedAssistantMessagesForTurn =
          turnId !== undefined
            ? hasAssistantMessageForTurn(messages, turnId, { completedOnly: true })
            : false;

        // A completion is only redundant when the turn already has a
        // *completed* assistant message; a live (still-streaming) one means
        // this completion is what closes it — e.g. after a restart, when the
        // in-memory segment state is gone.
        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasCompletedAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
          const completionBaseKey = String(event.itemId ?? event.turnId ?? event.eventId);
          // Resolve the message this completion belongs to: the turn's active
          // segment, else the id the deltas used for this base key, else a
          // freshly claimed id. The completion-only path (no prior deltas)
          // must claim too — a recycled provider item id would otherwise glue
          // this message into the earlier one that already took the raw id.
          const claimedForBaseKey = Option.isNone(activeAssistantMessageId)
            ? yield* Cache.getOption(
                claimedAssistantMessageIdByBaseKey,
                claimedBaseKeyCacheKey(thread.id, completionBaseKey),
              )
            : Option.none<MessageId>();
          // A base-key correlation only holds while the message it names is
          // still live. Once that message finalized, the provider recycled
          // the base key and this completion is a NEW message that must
          // claim its own id.
          const liveClaimedForBaseKey = Option.flatMap(claimedForBaseKey, (messageId) => {
            const existing = findMessageById(messages, messageId);
            return existing === undefined || existing.streaming
              ? Option.some(messageId)
              : Option.none();
          });
          // After a restart the correlation map is empty; a raw completion id
          // that still names a live message of this same turn (or of no turn)
          // continues in-flight work instead of minting a fresh id.
          const continueLiveMessage =
            (yield* getLiveAssistantMessageIds(thread.id)).has(assistantCompletion.messageId) &&
            (turnId === undefined ||
              (yield* liveMessageMatchesTurn(thread.id, assistantCompletion.messageId, turnId)));
          const assistantMessageId = Option.isSome(activeAssistantMessageId)
            ? activeAssistantMessageId.value
            : Option.isSome(liveClaimedForBaseKey)
              ? liveClaimedForBaseKey.value
              : continueLiveMessage
                ? assistantCompletion.messageId
                : yield* claimAssistantMessageId({
                    threadId: thread.id,
                    candidateId: assistantCompletion.messageId,
                  }).pipe(
                    // Persist the minted id so later events for this item
                    // (misordered deltas, duplicate completions) correlate to
                    // the same message instead of minting yet another id.
                    Effect.tap((messageId) =>
                      Cache.set(
                        claimedAssistantMessageIdByBaseKey,
                        claimedBaseKeyCacheKey(thread.id, completionBaseKey),
                        messageId,
                      ),
                    ),
                  );
          const existingAssistantMessage = findMessageById(messages, assistantMessageId);
          const shouldApplyFallbackCompletionText =
            !existingAssistantMessage || existingAssistantMessage.text.length === 0;

          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (proposedPlanCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: detailedThread?.proposedPlans ?? [],
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed") {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const proposedPlans = detailedThread?.proposedPlans ?? [];
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          // Flush any coalesced reasoning row before turn-final work so the
          // transcript reflects thinking that arrived with the last tokens.
          yield* flushPendingActivities(thread.id);

          // A compaction still in progress when the turn ends without a
          // completed row did not finish: surface a terminal failed/canceled
          // row so the work log does not show it as compacting forever.
          const turnState = normalizeRuntimeTurnState(event.payload.state);
          if (turnState !== "completed") {
            const synthesizedCompaction = synthesizeCompactionTerminalActivity({
              event,
              threadId: thread.id,
              turnId,
              status: turnState === "failed" ? "failed" : "canceled",
            });
            if (synthesizedCompaction) {
              yield* queueActivity(thread.id, event, synthesizedCompaction);
            }
          }
          // Compaction state is per-turn; drop it once the turn closes.
          compactionStateByTurnKey.delete(compactionTurnKey(thread.id, turnId));

          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: findMessageById(messages, assistantMessageId) !== undefined,
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
          yield* clearBufferedReasoningText(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });

          // Grok (and other providers) can complete with only tool activity or
          // late-arriving content that never projected. Surface a synthetic
          // assistant summary so delegate_task results and the UI are not empty.
          // Drop the per-event detail cache so we observe messages written by
          // the finalizers above.
          loadedThreadDetail = undefined;
          const refreshedThread = yield* getLoadedThreadDetail();
          const messagesAfter = refreshedThread?.messages ?? messages;
          if (!hasRenderableAssistantContentForTurn(messagesAfter, turnId)) {
            yield* generateFallbackCompletionMessage({
              event,
              threadId: thread.id,
              turnId,
              detailedThread: refreshedThread ?? detailedThread,
              createdAt: now,
            });
          }
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        // A runtime error during an in-progress compaction means the
        // compaction did not finish; surface a terminal failed row.
        const synthesizedCompaction = synthesizeCompactionTerminalActivity({
          event,
          threadId: thread.id,
          turnId: eventTurnId,
          status: "failed",
        });
        if (synthesizedCompaction) {
          yield* queueActivity(thread.id, event, synthesizedCompaction);
        }

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (turnId && checkpointContext && workspaceCwd && isGitRepository(workspaceCwd)) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: yield* providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
              createdAt: now,
            });
          }
        }
      }

      const compactionActivity = compactionActivityForEvent(event);
      if (compactionActivity) {
        yield* queueActivity(thread.id, event, compactionActivity);
      }

      const activities = runtimeEventToActivities(event);
      for (const activity of activities) {
        yield* queueActivity(thread.id, event, activity);
      }
    });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime"
      ? processRuntimeEvent(input.event)
      : input.source === "domain"
        ? processDomainEvent(input.event)
        : flushPendingActivities();

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          ...(input.source !== "flush"
            ? { eventId: input.event.eventId, eventType: input.event.type }
            : {}),
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          worker.enqueue({ source: "runtime", event }),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );
      yield* Effect.forkScoped(
        Effect.sleep(ACTIVITY_COALESCE_FLUSH_INTERVAL).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              pendingActivities.size > 0
                ? worker.enqueue({ source: "flush" }).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
          Effect.forever,
        ),
      );
    });

  return {
    start,
    // Drain must also empty the coalesce buffer: tests (and shutdown paths)
    // rely on drain() meaning "every observed event's effects are visible".
    // An event processed after a flush marker can buffer new activities, so
    // loop until a flush pass leaves pendingActivities empty.
    drain: Effect.gen(function* () {
      do {
        yield* worker.enqueue({ source: "flush" });
        yield* worker.drain;
      } while (pendingActivities.size > 0);
    }),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
