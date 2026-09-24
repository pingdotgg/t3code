import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  OrchestrationProposedPlanId,
  CheckpointRef,
  classifyTaskAgentKind,
  EventId,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ProviderRequestKind,
  type ProviderRuntimeEvent,
  type ResponseStreamingMode,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { formatTokens } from "@t3tools/shared/usageFormat";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { projectActivityPayload } from "../ActivityPayloadProjection.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { canReplaceThreadTitle } from "../threadTitles.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
// Suffixed, not prefixed: `clearTurnStateForSession` sweeps by thread prefix.
const segmentStateKey = (threadId: ThreadId, turnId: TurnId, role: MessageStreamRole) =>
  role === "reasoning"
    ? `${providerTurnKey(threadId, turnId)}:reasoning`
    : providerTurnKey(threadId, turnId);
const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;

// Fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
function findTaskTitleInActivities(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }> | undefined,
  taskId: string,
): string | undefined {
  if (!activities) {
    return undefined;
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || (activity.kind !== "task.started" && activity.kind !== "task.progress")) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as { taskId?: unknown; title?: unknown; detail?: unknown })
        : undefined;
    if (payload?.taskId !== taskId) {
      continue;
    }
    const title =
      typeof payload.title === "string"
        ? payload.title
        : activity.kind === "task.started" && typeof payload.detail === "string"
          ? payload.detail
          : undefined;
    if (title && title.trim().length > 0) {
      return title;
    }
  }
  return undefined;
}

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
const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;
const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
// Paragraphs that finish within this window after a delivery stay buffered
// and land together on the next one. Keeps fast models from repainting the
// message several times a second while still showing the first paragraph
// as soon as it is done.
const MIN_ASSISTANT_DELIVERY_INTERVAL_MS = 400;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type ProviderDiffEvent = Extract<ProviderRuntimeEvent, { type: "turn.diff.updated" }>;

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
      /** A diff whose workspace the diff worker confirmed is a Git repository. */
      source: "diff";
      event: ProviderDiffEvent;
    };

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

// An opening fence may sit at any indentation, since fences inside list
// items are indented past the marker. A closing fence may be indented at most
// three spaces more than its opener. Deeper lines are content in the block.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
// a no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// A bullet or ordered marker followed by whitespace, at any indentation so
// nested items count. The trailing space is required, so a partial `-` or
// `1.` never matches before the model finishes the marker.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
// A section title: an ATX heading, or a line of only bold text, which models
// often use as a heading.
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*[^*]+\*\*:?$)/;

/**
 * Splits buffered assistant text at the last blank line, closing code fence,
 * or list item start that is not inside an open fenced code block. `ready` is
 * safe to deliver now because the markdown before it will not change shape as
 * more text arrives. `rest` stays buffered until the next boundary or
 * completion. Only fully terminated lines count, so a trailing partial line
 * never leaks; a list item start is the one lookahead that may sit on the
 * partial line, since tight lists have no blank lines between items and would
 * otherwise land all at once.
 *
 * A section title holds the boundary until a content line follows it, so a
 * title never lands alone and waits above a block that is still streaming.
 */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  let openFence: { marker: string; indent: number } | null = null;
  let boundary = -1;
  let lineStart = 0;
  let titleAwaitingContent = false;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const line = text
      .slice(lineStart, newline === -1 ? text.length : newline)
      .replace(/[ \t\r]+$/, "");
    if (
      openFence === null &&
      lineStart > 0 &&
      !titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      boundary = lineStart;
    }
    if (newline === -1) {
      break;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
        titleAwaitingContent = false;
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null;
        boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) {
        boundary = newline + 1;
      }
    } else if (openFence === null) {
      titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    lineStart = newline + 1;
  }
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
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

/**
 * Reasoning shares the assistant segmenting, buffering and finalization
 * machinery; only the message id namespace differs. The prefix is what tells a
 * buffered segment apart when it is flushed or finalized long after the delta
 * that opened it, so the role never has to be threaded through those paths.
 */
type MessageStreamRole = "assistant" | "reasoning";

const REASONING_MESSAGE_ID_PREFIX = "reasoning:";

function messageStreamRoleOf(messageId: MessageId): MessageStreamRole {
  return messageId.startsWith(REASONING_MESSAGE_ID_PREFIX) ? "reasoning" : "assistant";
}

function assistantSegmentMessageId(
  baseKey: string,
  segmentIndex: number,
  role: MessageStreamRole = "assistant",
): MessageId {
  const prefix = role === "reasoning" ? REASONING_MESSAGE_ID_PREFIX : "assistant:";
  return MessageId.make(
    segmentIndex === 0 ? `${prefix}${baseKey}` : `${prefix}${baseKey}:segment:${segmentIndex}`,
  );
}

/** A provider may stream a reasoning summary and the raw chain of thought over
 *  the same item. They are different texts, so they get different segments. */
function reasoningSegmentBaseKeyFromEvent(
  event: ProviderRuntimeEvent,
  streamKind: "reasoning_text" | "reasoning_summary_text",
): string {
  const stream = streamKind === "reasoning_summary_text" ? "summary" : "raw";
  return `${stream}:${assistantSegmentBaseKeyFromEvent(event)}`;
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens < 0) {
    return undefined;
  }
  return event.payload.usage;
}

function compactedTokenCountsFromActivities(
  activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "kind" | "payload" | "sequence" | "createdAt">
  >,
): { readonly beforeTokens: number; readonly afterTokens: number } | undefined {
  const lastCompactionIndex = activities.findLastIndex(
    (activity) => activity.kind === "context-compaction",
  );
  const lastCompaction = activities[lastCompactionIndex];
  const activitiesSinceLastCompaction = activities.slice(lastCompactionIndex + 1);
  const usedTokens = activitiesSinceLastCompaction.flatMap((activity) => {
    if (activity.kind !== "context-window.updated") return [];
    if (lastCompaction !== undefined) {
      const isAfterLastCompaction =
        activity.sequence !== undefined && lastCompaction.sequence !== undefined
          ? activity.sequence > lastCompaction.sequence
          : activity.createdAt > lastCompaction.createdAt;
      if (!isAfterLastCompaction) return [];
    }
    const payload = Predicate.isObject(activity.payload) ? activity.payload : undefined;
    return Predicate.isNumber(payload?.usedTokens) && payload.usedTokens >= 0
      ? [payload.usedTokens]
      : [];
  });
  const beforeTokens = usedTokens.at(-2);
  const afterTokens = usedTokens.at(-1);
  if (beforeTokens === undefined || afterTokens === undefined || afterTokens >= beforeTokens) {
    return undefined;
  }
  return { beforeTokens, afterTokens };
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
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
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

function sessionStatusAllowsActiveTurn(
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean {
  return status === "starting" || status === "running";
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): ProviderRequestKind | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    case "permission_approval":
      return "permission";
    default:
      return undefined;
  }
}

/**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
function taskLinkageActivityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    }),
  };
  for (const key of [
    "taskType",
    "agentId",
    "title",
    "role",
    "model",
    "effort",
    "toolUseId",
    "parentAgentId",
    "workflowName",
    "agentIndex",
    "phaseIndex",
    "phaseTitle",
    "phases",
    "attempt",
    "runHandles",
    "outputFile",
    "agentPath",
    "timelineBypass",
    "typedUsage",
    "status",
    "error",
  ] as const) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields;
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
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
                  : requestKind === "mcp-elicitation"
                    ? "App access approval requested"
                    : requestKind === "permission"
                      ? "App permission approval requested"
                      : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
            ...(event.payload.appName ? { appName: event.payload.appName } : {}),
            ...(event.payload.options ? { options: event.payload.options } : {}),
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
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
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
            ...(event.payload.responseMode ? { responseMode: event.payload.responseMode } : {}),
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
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const linkage = taskLinkageActivityFields(event.payload as Record<string, unknown>);
      // Usage and activity are independent latest-state streams. Keeping them
      // under separate stable ids prevents a command/reasoning update from
      // replacing the last known token count (and prevents a usage-only tick
      // from blanking the last meaningful activity).
      const identityLinkage = { ...linkage };
      delete identityLinkage.typedUsage;
      delete identityLinkage.status;
      delete identityLinkage.error;
      const title =
        event.payload.description.trim().length > 0
          ? { title: truncateDetail(event.payload.description, 120) }
          : {};
      const hasProgressState =
        event.payload.typedUsage === undefined ||
        event.payload.summary !== undefined ||
        event.payload.lastToolName !== undefined ||
        event.payload.status !== undefined ||
        event.payload.error !== undefined;
      return [
        ...(hasProgressState
          ? [
              {
                // Stable per-task id: activity is "latest state", not
                // history, so each meaningful tick replaces the last. This
                // bounds a large fleet to one activity row per task.
                id: EventId.make(`task-progress:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary:
                  event.payload.description.trim().length > 0
                    ? truncateDetail(event.payload.description, 120)
                    : "Reasoning update",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  detail: truncateDetail(event.payload.summary ?? event.payload.description),
                  ...(event.payload.summary
                    ? { summary: truncateDetail(event.payload.summary) }
                    : {}),
                  ...(event.payload.lastToolName
                    ? { lastToolName: event.payload.lastToolName }
                    : {}),
                  ...(event.payload.status ? { status: event.payload.status } : {}),
                  ...(event.payload.error ? { error: event.payload.error } : {}),
                  ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
                  ...identityLinkage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
        ...(event.payload.typedUsage !== undefined
          ? [
              {
                id: EventId.make(`task-usage:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary: "Task usage updated",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  ...identityLinkage,
                  usageSnapshot: true,
                  typedUsage: event.payload.typedUsage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status
                ? `Task ${event.payload.status}`
                : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.endedAt ? { endedAt: event.payload.endedAt } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Only agent-owned heartbeats are persisted: they feed the owning
      // agent's activity line. Parent-conversation tool progress stays
      // ephemeral (item lifecycle already covers it).
      if (event.payload.taskId === undefined) {
        return [];
      }
      return [
        {
          // Same stable-id treatment as task.progress: a heartbeat is
          // "what is this agent doing right now", so one row per task
          // (thread-scoped for the same global-PK collision reason).
          id: EventId.make(`tool-progress:${event.threadId}:${event.payload.taskId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
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
            status: event.payload.status,
            ...(taskTitle ? { title: truncateDetail(taskTitle, 120) } : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      const beforeTokens = event.payload.beforeTokens;
      const afterTokens = event.payload.afterTokens;
      const summary =
        beforeTokens !== undefined && afterTokens !== undefined
          ? `Compacted context ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens`
          : "Context compacted";
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary,
          payload: {
            state: event.payload.state,
            ...(beforeTokens !== undefined ? { beforeTokens } : {}),
            ...(afterTokens !== undefined ? { afterTokens } : {}),
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
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
      // A streaming update's `data` carries the full tool output accumulated
      // so far (adapters merge state forward), and a new activity is emitted
      // per chunk, so persisting `data` verbatim writes O(N²) bytes per tool
      // call into both the event store and the projection table. No reader
      // needs it: ws.ts and http.ts apply `projectActivityPayload` before any
      // payload reaches a client. Persist the projected form for non-terminal
      // updates; `item.completed` below still persists the full payload.
      return [
        projectActivityPayload({
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.toolSurface ? { toolSurface: event.payload.toolSurface } : {}),
            ...(event.payload.toolIcon ? { toolIcon: event.payload.toolIcon } : {}),
            ...(event.payload.toolSource ? { toolSource: event.payload.toolSource } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        }),
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
            ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.toolSurface ? { toolSurface: event.payload.toolSurface } : {}),
            ...(event.payload.toolIcon ? { toolIcon: event.payload.toolIcon } : {}),
            ...(event.payload.toolSource ? { toolSource: event.payload.toolSource } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
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
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.toolSurface ? { toolSurface: event.payload.toolSurface } : {}),
            ...(event.payload.toolIcon ? { toolIcon: event.payload.toolIcon } : {}),
            ...(event.payload.toolSource ? { toolSource: event.payload.toolSource } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
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
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const threadPlanProgress = yield* ThreadPlanProgressService;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionThreadMessages = yield* ProjectionThreadMessageRepository;
  const projectionThreadProposedPlans = yield* ProjectionThreadProposedPlanRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const providerCommandId = (event: ProviderRuntimeEvent, tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`provider:${event.eventId}:${tag}:${uuid}`)),
    );

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
  // Epoch millis of the last early delivery per message, for pacing.
  const lastAssistantDeliveryAtByMessageId = yield* Cache.make<MessageId, number>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(0),
  });

  // When a thinking block opened, so "Thought for ..." measures the model's
  // time and not the moment buffered text happened to be flushed.
  const reasoningStartedAtByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  // Codex splits a reasoning trace into indexed parts, summary and raw alike.
  // The index is the only signal that one part ended and the next began, so the
  // blank line that keeps them readable has to be inserted here.
  const reasoningPartIndexByMessageId = yield* Cache.make<MessageId, number>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(-1),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  // Task names arrive on task.started/task.progress but not on task.completed,
  // so remember them per task to title the completion activity.
  const taskDescriptionByTaskKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberTaskDescription = (threadId: ThreadId, taskId: string, description: string) =>
    Cache.set(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId), description);

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskDescription = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map((description) =>
        Option.filter(description, (value) => value.length > 0).pipe(Option.getOrUndefined),
      ),
    );

  const resolveThreadRuntimeContext = Effect.fn("resolveThreadRuntimeContext")(function* (
    threadId: ThreadId,
  ) {
    return yield* projectionSnapshotQuery
      .getThreadRuntimeContext(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const getThreadMessageById = Effect.fn("getThreadMessageById")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const message = yield* projectionThreadMessages.getByMessageId({ messageId });
    return Option.filter(message, (entry) => entry.threadId === threadId).pipe(
      Option.getOrUndefined,
    );
  });

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

  const getAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    role: MessageStreamRole = "assistant",
  ) => Cache.getOption(assistantSegmentStateByTurnKey, segmentStateKey(threadId, turnId, role));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
    role: MessageStreamRole = "assistant",
  ) => Cache.set(assistantSegmentStateByTurnKey, segmentStateKey(threadId, turnId, role), state);

  const clearAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    role: MessageStreamRole = "assistant",
  ) => Cache.invalidate(assistantSegmentStateByTurnKey, segmentStateKey(threadId, turnId, role));

  const getActiveAssistantMessageIdForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    role: MessageStreamRole = "assistant",
  ) =>
    getAssistantSegmentStateForTurn(threadId, turnId, role).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
    role?: MessageStreamRole;
  }) => {
    const role = input.role ?? "assistant";
    return getAssistantSegmentStateForTurn(input.threadId, input.turnId, role).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0, role),
            }),
            onSome: (state) => {
              // Reasoning never resets the index on a new base key: one item can
              // stream a summary and a raw trace, and summary -> raw -> summary
              // would otherwise reuse the id of the first, finished block.
              const reuseIndex = state.baseKey === input.baseKey || role === "reasoning";
              const segmentIndex = reuseIndex ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex, role);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: reuseIndex ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState, role);
          return nextState.activeMessageId!;
        }),
      ),
    );
  };

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
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

  /**
   * Unlike assistant text, reasoning has no reliable per-block item id on every
   * provider, so a turn's blocks can share a base key. Switching base key (a new
   * reasoning item, or summary vs raw) closes the open block instead of
   * appending to it.
   */
  const getOrCreateReasoningMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    baseKey: string;
    createdAt: string;
    turnId: TurnId;
  }) =>
    Effect.gen(function* () {
      const state = yield* getAssistantSegmentStateForTurn(
        input.threadId,
        input.turnId,
        "reasoning",
      );
      const activeMessageId = Option.flatMap(state, (entry) =>
        entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
      );
      if (Option.isSome(activeMessageId)) {
        if (Option.getOrUndefined(state)?.baseKey === input.baseKey) {
          return activeMessageId.value;
        }
        yield* finalizeActiveSegmentForTurn({
          event: input.event,
          threadId: input.threadId,
          turnId: input.turnId,
          createdAt: input.createdAt,
          commandTag: "reasoning-complete-on-new-block",
          finalDeltaCommandTag: "reasoning-delta-finalize-on-new-block",
          hasProjectedMessage: false,
          role: "reasoning",
        });
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: input.baseKey,
        role: "reasoning",
      });
    });

  const resolveResponseStreamingMode = (projectId: ProjectId) =>
    Effect.map(
      serverSettingsService.getSettings,
      (settings) => resolveProjectSettings(settings, projectId).settings.responseStreamingMode,
    );

  // `mode` is "turn" or "paragraph"; token mode never buffers.
  const appendBufferedAssistantText = (
    messageId: MessageId,
    delta: string,
    mode: Exclude<ResponseStreamingMode, "token">,
    atMillis: number,
  ) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });

          // Paragraph mode delivers finished paragraphs and closed code blocks
          // early so the user sees progress without token-by-token repaints.
          // Turn mode holds everything until the turn finishes or pauses.
          const { ready, rest } =
            mode === "paragraph"
              ? splitBufferedAssistantText(nextText)
              : { ready: "", rest: nextText };
          const lastDeliveredAt = Option.getOrUndefined(
            yield* Cache.getOption(lastAssistantDeliveryAtByMessageId, messageId),
          );
          const paced =
            lastDeliveredAt === undefined ||
            atMillis - lastDeliveredAt >= MIN_ASSISTANT_DELIVERY_INTERVAL_MS;
          if (
            paced &&
            hasRenderableAssistantText(ready) &&
            rest.length <= MAX_BUFFERED_ASSISTANT_CHARS
          ) {
            if (rest.length > 0) {
              yield* Cache.set(bufferedAssistantTextByMessageId, messageId, rest);
            } else {
              yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
            }
            yield* Cache.set(lastAssistantDeliveryAtByMessageId, messageId, atMillis);
            return ready;
          }

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
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.andThen(Cache.invalidate(lastAssistantDeliveryAtByMessageId, messageId)),
    );

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

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId).pipe(
      Effect.andThen(Cache.invalidate(reasoningPartIndexByMessageId, messageId)),
      Effect.andThen(Cache.invalidate(reasoningStartedAtByMessageId, messageId)),
    );

  const reasoningStartedAt = (messageId: MessageId, fallback: string) =>
    Cache.getOption(reasoningStartedAtByMessageId, messageId).pipe(
      Effect.map((started) => Option.getOrElse(started, () => fallback) || fallback),
    );

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

      const isReasoning = messageStreamRoleOf(input.messageId) === "reasoning";
      yield* orchestrationEngine.dispatch({
        type: isReasoning ? "thread.message.reasoning.delta" : "thread.message.assistant.delta",
        commandId: yield* providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: isReasoning
          ? yield* reasoningStartedAt(input.messageId, input.createdAt)
          : input.createdAt,
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

      const isReasoning = messageStreamRoleOf(input.messageId) === "reasoning";

      if (hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: isReasoning ? "thread.message.reasoning.delta" : "thread.message.assistant.delta",
          commandId: yield* providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: isReasoning
            ? yield* reasoningStartedAt(input.messageId, input.createdAt)
            : input.createdAt,
        });
      }

      if (input.hasProjectedMessage || hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: isReasoning
            ? "thread.message.reasoning.complete"
            : "thread.message.assistant.complete",
          commandId: yield* providerCommandId(input.event, input.commandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
    role?: MessageStreamRole;
    fallbackText?: string;
  }) =>
    Effect.gen(function* () {
      const role = input.role ?? "assistant";
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
        role,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      // A block whose deltas already reached the projection must still be
      // completed, or it stays flagged as streaming forever.
      const alreadyProjected =
        input.hasProjectedMessage ||
        (input.flushedMessageIds?.has(activeMessageId.value) ?? false) ||
        (role === "reasoning"
          ? (yield* getThreadMessageById(input.threadId, activeMessageId.value)) !== undefined
          : false);

      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage: alreadyProjected,
        ...(input.fallbackText !== undefined ? { fallbackText: input.fallbackText } : {}),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      // The segment index is deliberately preserved: reasoning blocks in one
      // turn can share a base key, so resetting it would reopen a closed block.
      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId, role);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(
          input.threadId,
          input.turnId,
          { ...state.value, activeMessageId: null },
          role,
        );
      }
    });

  const finalizeBufferedProposedPlan = Effect.fn("finalizeBufferedProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) {
    const bufferedPlan = Option.getOrUndefined(
      yield* Cache.getOption(bufferedProposedPlanById, input.planId),
    );
    const planMarkdown =
      normalizeProposedPlanMarkdown(bufferedPlan?.text) ??
      normalizeProposedPlanMarkdown(input.fallbackMarkdown);
    if (!planMarkdown) return yield* clearBufferedProposedPlan(input.planId);

    const existingPlan = Option.getOrUndefined(
      yield* projectionThreadProposedPlans.getByPlanId({
        threadId: input.threadId,
        planId: OrchestrationProposedPlanId.make(input.planId),
      }),
    );
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
        createdAt: existingPlan?.createdAt ?? (bufferedPlan?.createdAt || input.updatedAt),
        updatedAt: input.updatedAt,
      },
      createdAt: input.updatedAt,
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
      const taskDescriptionKeys = Array.from(yield* Cache.keys(taskDescriptionByTaskKey));
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
        taskDescriptionKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskDescriptionByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
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
      const sourceThread = yield* resolveThreadRuntimeContext(sourceThreadId);
      const sourcePlan = Option.getOrUndefined(
        yield* projectionThreadProposedPlans.getByPlanId({
          threadId: sourceThreadId,
          planId: sourcePlanId,
        }),
      );
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      const commandUuid = yield* crypto.randomUUIDv4;
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${commandUuid}`,
        ),
        threadId: sourceThreadId,
        proposedPlan: {
          id: sourcePlan.planId,
          turnId: sourcePlan.turnId,
          planMarkdown: sourcePlan.planMarkdown,
          createdAt: sourcePlan.createdAt,
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
      if (
        event.type === "content.delta" &&
        event.payload.streamKind !== "assistant_text" &&
        event.payload.streamKind !== "reasoning_text" &&
        event.payload.streamKind !== "reasoning_summary_text"
      ) {
        return;
      }

      const thread = yield* resolveThreadRuntimeContext(event.threadId);
      if (!thread) return;

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const isTerminalTurn = event.type === "turn.completed" || event.type === "turn.aborted";
      const isCompactedThreadState =
        event.type === "thread.state.changed" && event.payload.state === "compacted";
      const pendingTurnStart =
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        isTerminalTurn ||
        isCompactedThreadState
          ? yield* projectionTurnRepository.getPendingTurnStartByThreadId({
              threadId: thread.id,
            })
          : Option.none();
      const hasPendingTurnStart =
        Option.isSome(pendingTurnStart) && thread.session?.status === "starting";

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      // A turn.started that conflicts with the active turn is legitimate when
      // the server itself has a turn start pending for this thread AND the
      // provider session already tracks the event's turn as its active turn:
      // steering a running turn makes some providers (e.g. opencode) open a
      // new turn without ever completing the superseded one. A stale
      // turn.started for some other turn id still gets rejected.
      const conflictingTurnStartIsPendingTurnStart =
        event.type === "turn.started" && conflictsWithActiveTurn
          ? sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId) &&
            Option.isSome(pendingTurnStart)
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
            return !conflictsWithActiveTurn || conflictingTurnStartIsPendingTurnStart;
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // A named completion can recover a lost turn.started event.
            // An abort needs an active turn so a delayed stop cannot replace
            // a ready session or clear a newer pending start.
            return event.type === "turn.completed" && eventTurnId !== undefined;
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
        isTerminalTurn
      ) {
        const status = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const runtimeStatus = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              return hasPendingTurnStart && runtimeStatus === "ready" ? "starting" : runtimeStatus;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.aborted":
              return "interrupted";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active or pending turn; preserve that lifecycle state.
              return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
          }
        })();
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : isTerminalTurn || event.type === "session.exited"
              ? null
              : event.type === "session.state.changed" &&
                  !sessionStatusAllowsActiveTurn(
                    orchestrationSessionStatusFromRuntimeState(event.payload.state),
                  )
                ? null
                : activeTurnId;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready" || status === "interrupted"
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
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const reasoningDelta =
        event.type === "content.delta" &&
        (event.payload.streamKind === "reasoning_text" ||
          event.payload.streamKind === "reasoning_summary_text")
          ? {
              streamKind: event.payload.streamKind,
              delta: event.payload.delta,
              summaryIndex: event.payload.summaryIndex,
              contentIndex: event.payload.contentIndex,
            }
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      const reasoningTurnId = toTurnId(event.turnId);
      // Every close path for a thinking block is keyed by turn. Without one the
      // block could never be completed, and a row stuck mid-thought is worse
      // than no row at all.
      if (reasoningDelta && reasoningDelta.delta.length > 0 && reasoningTurnId) {
        const turnId = reasoningTurnId;
        const reasoningMessageId = yield* getOrCreateReasoningMessageId({
          threadId: thread.id,
          event,
          baseKey: reasoningSegmentBaseKeyFromEvent(event, reasoningDelta.streamKind),
          createdAt: now,
          turnId,
        });
        yield* rememberAssistantMessageId(thread.id, turnId, reasoningMessageId);

        if (
          Option.getOrElse(
            yield* Cache.getOption(reasoningStartedAtByMessageId, reasoningMessageId),
            () => "",
          ) === ""
        ) {
          yield* Cache.set(reasoningStartedAtByMessageId, reasoningMessageId, now);
        }

        let delta = reasoningDelta.delta;
        const partIndex = reasoningDelta.summaryIndex ?? reasoningDelta.contentIndex;
        if (partIndex !== undefined) {
          const lastIndex = Option.getOrElse(
            yield* Cache.getOption(reasoningPartIndexByMessageId, reasoningMessageId),
            () => -1,
          );
          if (lastIndex >= 0 && lastIndex !== partIndex) {
            delta = `\n\n${delta}`;
          }
          yield* Cache.set(reasoningPartIndexByMessageId, reasoningMessageId, partIndex);
        }

        // Reasoning is never delivered token by token, even when the project
        // asks for it: the block is collapsed by default, so a command, an
        // event-store write and a fan-out per token would buy nothing. Traces
        // are longer than the answers they precede.
        const streamingMode = yield* resolveResponseStreamingMode(thread.projectId);
        const reasoningMode = streamingMode === "token" ? "paragraph" : streamingMode;
        const spillChunk = yield* appendBufferedAssistantText(
          reasoningMessageId,
          delta,
          reasoningMode,
          yield* Clock.currentTimeMillis,
        );
        if (spillChunk.length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.reasoning.delta",
            commandId: yield* providerCommandId(event, "reasoning-delta-buffer-spill"),
            threadId: thread.id,
            messageId: reasoningMessageId,
            delta: spillChunk,
            turnId,
            createdAt: yield* reasoningStartedAt(reasoningMessageId, now),
          });
        }
      }

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        // Visible text ends the thinking block that preceded it, so the next
        // block does not swallow this answer.
        if (turnId) {
          yield* finalizeActiveSegmentForTurn({
            event,
            threadId: thread.id,
            turnId,
            createdAt: now,
            commandTag: "reasoning-complete-on-assistant-text",
            finalDeltaCommandTag: "reasoning-delta-finalize-on-assistant-text",
            hasProjectedMessage: false,
            role: "reasoning",
          });
        }
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const streamingMode = yield* resolveResponseStreamingMode(thread.projectId);
        if (streamingMode !== "token") {
          // Pace on the server clock. OpenCode stamps every delta of a part
          // with the part's start time, so the event time cannot measure gaps.
          const spillChunk = yield* appendBufferedAssistantText(
            assistantMessageId,
            assistantDelta,
            streamingMode,
            yield* Clock.currentTimeMillis,
          );
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

      const pauseForUserTurnId =
        event.type === "request.opened" ||
        (event.type === "user-input.requested" && event.payload.responseMode !== "message")
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const hasProjectedMessage = yield* projectionThreadMessages.hasAssistantMessageForTurn({
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          streamingOnly: true,
        });
        const streamingMode = yield* resolveResponseStreamingMode(thread.projectId);
        const flushedMessageIds =
          streamingMode !== "token"
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
        yield* finalizeActiveSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag: "reasoning-complete-on-pause",
          finalDeltaCommandTag: "reasoning-delta-finalize-on-pause",
          hasProjectedMessage: false,
          role: "reasoning",
          flushedMessageIds,
        });
        yield* finalizeActiveSegmentForTurn({
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
          hasProjectedMessage,
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      // Tool work ends the thinking block that led to it. Without this a
      // provider that reuses one reasoning stream across a turn (Claude has no
      // per-block id) would append post-tool thinking to a block that already
      // sits above the tool row.
      if (event.type === "item.started" && isToolLifecycleItemType(event.payload.itemType)) {
        const toolTurnId = toTurnId(event.turnId);
        if (toolTurnId) {
          yield* finalizeActiveSegmentForTurn({
            event,
            threadId: thread.id,
            turnId: toolTurnId,
            createdAt: now,
            commandTag: "reasoning-complete-on-tool-start",
            finalDeltaCommandTag: "reasoning-delta-finalize-on-tool-start",
            hasProjectedMessage: false,
            role: "reasoning",
          });
        }
      }

      if (event.type === "item.completed" && event.payload.itemType === "reasoning") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const activeReasoningMessageId = yield* getActiveAssistantMessageIdForTurn(
            thread.id,
            turnId,
            "reasoning",
          );
          // The item detail is a whole-block snapshot, so it may only stand in
          // for deltas that never arrived. Appending it to a streamed block
          // would print the reasoning twice.
          const existingReasoningMessage = Option.isSome(activeReasoningMessageId)
            ? yield* getThreadMessageById(thread.id, activeReasoningMessageId.value)
            : undefined;
          const fallbackText =
            event.payload.detail !== undefined &&
            event.payload.detail.trim().length > 0 &&
            (existingReasoningMessage === undefined || existingReasoningMessage.text.length === 0)
              ? event.payload.detail
              : undefined;

          if (Option.isNone(activeReasoningMessageId)) {
            // Segment state outlives a closed block, so its presence means this
            // turn already streamed a trace and the snapshot would duplicate it.
            const turnAlreadyStreamedReasoning = Option.isSome(
              yield* getAssistantSegmentStateForTurn(thread.id, turnId, "reasoning"),
            );
            // A provider can report a whole block at once without streaming it.
            // The id is derived from the item rather than the segment counter so
            // a repeated completion rewrites that row instead of adding a copy.
            if (fallbackText !== undefined && !turnAlreadyStreamedReasoning) {
              const snapshotMessageId = assistantSegmentMessageId(
                `snapshot:${event.itemId ?? event.eventId}`,
                0,
                "reasoning",
              );
              const existingSnapshot = yield* getThreadMessageById(thread.id, snapshotMessageId);
              if (existingSnapshot === undefined) {
                yield* orchestrationEngine.dispatch({
                  type: "thread.message.reasoning.delta",
                  commandId: yield* providerCommandId(event, "reasoning-delta-snapshot"),
                  threadId: thread.id,
                  messageId: snapshotMessageId,
                  delta: fallbackText,
                  turnId,
                  createdAt: now,
                });
                yield* orchestrationEngine.dispatch({
                  type: "thread.message.reasoning.complete",
                  commandId: yield* providerCommandId(event, "reasoning-complete-snapshot"),
                  threadId: thread.id,
                  messageId: snapshotMessageId,
                  turnId,
                  createdAt: now,
                });
              }
            }
          } else {
            yield* finalizeActiveSegmentForTurn({
              event,
              threadId: thread.id,
              turnId,
              createdAt: now,
              commandTag: "reasoning-complete",
              finalDeltaCommandTag: "reasoning-delta-finalize",
              hasProjectedMessage: existingReasoningMessage !== undefined,
              role: "reasoning",
              ...(fallbackText !== undefined ? { fallbackText } : {}),
            });
          }
        }
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
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* finalizeActiveSegmentForTurn({
            event,
            threadId: thread.id,
            turnId,
            createdAt: now,
            commandTag: "reasoning-complete-on-assistant-completion",
            finalDeltaCommandTag: "reasoning-delta-finalize-on-assistant-completion",
            hasProjectedMessage: false,
            role: "reasoning",
          });
        }
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const [existingAssistantMessage, hasAssistantMessagesForTurn] = yield* Effect.all([
          getThreadMessageById(thread.id, assistantMessageId),
          turnId === undefined
            ? Effect.succeed(false)
            : projectionThreadMessages.hasAssistantMessageForTurn({
                threadId: thread.id,
                turnId,
                streamingOnly: false,
              }),
        ]);
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
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
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (isTerminalTurn) {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const userInputActivities =
            yield* projectionThreadActivityRepository.listUserInputLifecycleByThreadId({
              threadId: thread.id,
            });
          const pendingRequestIds = new Set<string>();
          for (const activity of userInputActivities) {
            const payload =
              typeof activity.payload === "object" && activity.payload !== null
                ? (activity.payload as Record<string, unknown>)
                : null;
            const requestId = payload?.requestId;
            if (typeof requestId !== "string") continue;
            if (
              activity.kind === "user-input.requested" &&
              activity.turnId === turnId &&
              payload?.responseMode !== "message"
            ) {
              pendingRequestIds.add(requestId);
            } else if (activity.kind === "user-input.resolved") {
              pendingRequestIds.delete(requestId);
            }
          }
          // A terminal turn cannot accept native callback answers. Message-mode
          // questions may outlive that turn and still accept a later user message.
          for (const requestId of pendingRequestIds) {
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: yield* providerCommandId(event, "terminal-user-input-resolved"),
              threadId: thread.id,
              activity: {
                id: EventId.make(`${event.eventId}:user-input-resolved:${requestId}`),
                createdAt: now,
                tone: "info",
                kind: "user-input.resolved",
                summary: "User input dismissed",
                payload: { requestId },
                turnId,
              },
              createdAt: now,
            });
          }
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              getThreadMessageById(thread.id, assistantMessageId).pipe(
                Effect.flatMap((existingMessage) =>
                  finalizeAssistantMessage({
                    event,
                    threadId: thread.id,
                    messageId: assistantMessageId,
                    turnId,
                    createdAt: now,
                    commandTag: "assistant-complete-finalize",
                    finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                    hasProjectedMessage: existingMessage !== undefined,
                  }),
                ),
              ),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId, "reasoning");

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

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
        if (thread.titleState?.source !== "manual" && canReplaceThreadTitle(thread.title)) {
          yield* orchestrationEngine.dispatch({
            type: "thread.title.generate.complete",
            commandId: yield* providerCommandId(event, "thread-meta-update"),
            threadId: thread.id,
            title: event.payload.name,
            expectedTitle: thread.title,
            expectedVersion: thread.titleState?.version ?? null,
            needsRefinement: false,
          });
        }
      }

      if (event.type === "task.started" || event.type === "task.progress") {
        const description = event.payload.description?.trim();
        if (description) {
          yield* rememberTaskDescription(thread.id, event.payload.taskId, description);
        }
      }
      // Working-indicator plan progress: current step while the turn runs,
      // cleared on settle so a finished plan never lingers as stale UI.
      // Events carrying a turn id that conflicts with the active turn are
      // stale (superseded turn) and must neither overwrite nor clear the
      // active turn's progress; session.exited always clears.
      if (event.type === "session.exited") {
        threadPlanProgress.clearThreadPlanProgress(thread.id);
      } else if (!conflictsWithActiveTurn) {
        if (event.type === "turn.plan.updated") {
          threadPlanProgress.recordPlanProgress(thread.id, event.payload.plan);
        } else if (isTerminalTurn && shouldApplyThreadLifecycle) {
          threadPlanProgress.clearThreadPlanProgress(thread.id);
        }
      }

      // Sidebar background liveness: fed from the same lifecycle stream,
      // read by the shell query at mapping time (no persistence).
      switch (event.type) {
        case "task.started":
        case "task.progress":
        case "task.updated":
        case "task.completed": {
          const payload = event.payload as {
            taskId: string;
            taskType?: string;
            status?: string;
            agentId?: string;
          };
          threadBackgroundLiveness.recordTaskLiveness({
            threadId: thread.id,
            taskId: payload.taskId,
            taskType: payload.taskType,
            status: payload.status,
            agentId: payload.agentId,
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.progress"
                  ? "progress"
                  : event.type === "task.updated"
                    ? "updated"
                    : "completed",
          });
          break;
        }
        case "session.exited":
          threadBackgroundLiveness.clearThreadLiveness(thread.id);
          break;
        default:
          break;
      }

      let taskTitle: string | undefined;
      if (event.type === "task.completed") {
        taskTitle = yield* lookupTaskDescription(thread.id, event.payload.taskId);
        if (!taskTitle) {
          const taskActivity = yield* projectionThreadActivityRepository.getLatestTaskActivity({
            threadId: thread.id,
            taskId: event.payload.taskId,
          });
          taskTitle = findTaskTitleInActivities(
            Option.match(taskActivity, {
              onNone: () => undefined,
              onSome: (activity) => [activity],
            }),
            event.payload.taskId,
          );
        }
      }

      let activityEvent = event;
      if (
        isCompactedThreadState &&
        event.requestId === undefined &&
        Option.isSome(pendingTurnStart) &&
        thread.session?.status === "starting" &&
        activeTurnId === null &&
        sameId(thread.session.providerName, event.provider) &&
        sameId(thread.session.providerInstanceId, event.providerInstanceId) &&
        DateTime.isGreaterThanOrEqualTo(
          DateTime.makeUnsafe(event.createdAt),
          DateTime.makeUnsafe(pendingTurnStart.value.requestedAt),
        )
      ) {
        const pendingMessage = yield* getThreadMessageById(
          thread.id,
          pendingTurnStart.value.messageId,
        );
        if (
          pendingMessage?.role === "user" &&
          (pendingMessage.attachments?.length ?? 0) === 0 &&
          pendingMessage.text.trim().toLowerCase() === "/compact"
        ) {
          activityEvent = {
            ...event,
            requestId: RuntimeRequestId.make(String(pendingTurnStart.value.messageId)),
          };
        }
      }
      if (
        activityEvent.type === "thread.state.changed" &&
        activityEvent.payload.state === "compacted" &&
        (activityEvent.payload.beforeTokens === undefined ||
          activityEvent.payload.afterTokens === undefined)
      ) {
        const activities = yield* projectionThreadActivityRepository.listByThreadId({
          threadId: thread.id,
          activityKinds: ["context-window.updated", "context-compaction"],
          // Preserve the previous thread-detail read's context-history bound.
          limit: 500,
        });
        const tokenCounts = compactedTokenCountsFromActivities(activities);
        if (tokenCounts) {
          activityEvent = {
            ...activityEvent,
            payload: {
              ...activityEvent.payload,
              beforeTokens: activityEvent.payload.beforeTokens ?? tokenCounts.beforeTokens,
              afterTokens: activityEvent.payload.afterTokens ?? tokenCounts.afterTokens,
            },
          };
        }
      }

      const activities = runtimeEventToActivities(activityEvent, taskTitle);
      yield* Effect.forEach(activities, (activity) =>
        providerCommandId(event, "thread-activity-append").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: thread.id,
              activity,
              createdAt: activity.createdAt,
            }),
          ),
        ),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  // Records a mid-turn placeholder checkpoint for a provider diff. Runs on the
  // lifecycle worker, after repository detection, so the running-turn check
  // and the dispatch are ordered with the turn's terminal events: a diff that
  // resolved after turn.completed must not rewrite the settled turn's state or
  // move the latest-turn pointer back.
  const recordProviderDiff = Effect.fn("recordProviderDiff")(function* (event: ProviderDiffEvent) {
    const thread = yield* resolveThreadRuntimeContext(event.threadId);
    const turnId = toTurnId(event.turnId);
    if (!thread || !turnId) return;
    const turn = yield* projectionTurnRepository.getByTurnId({ threadId: thread.id, turnId });
    if (Option.isNone(turn) || turn.value.state !== "running") return;
    const checkpointContext = yield* projectionSnapshotQuery
      .getThreadCheckpointContext(thread.id)
      .pipe(Effect.map(Option.getOrUndefined));
    // Skip if a checkpoint already exists for this turn. A real
    // (non-placeholder) capture from CheckpointReactor should not
    // be clobbered, and dispatching a duplicate placeholder for the
    // same turnId would produce an unstable checkpointTurnCount.
    if (!checkpointContext || hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) return;
    const now = event.createdAt;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* providerCommandId(event, "thread-turn-diff-complete"),
      threadId: thread.id,
      turnId,
      completedAt: now,
      checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
      status: "missing",
      files: [],
      assistantMessageId: MessageId.make(
        `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
      ),
      checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
      createdAt: now,
    });
  });

  const processInput = (input: RuntimeIngestionInput) => {
    switch (input.source) {
      case "runtime":
        return processRuntimeEvent(input.event);
      case "domain":
        return processDomainEvent(input.event);
      case "diff":
        return recordProviderDiff(input.event);
    }
  };

  const logIngestionFailure =
    (source: string, event: { readonly eventId: string; readonly type: string }) =>
    <E, R>(effect: Effect.Effect<void, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider runtime ingestion failed to process event", {
            source,
            eventId: event.eventId,
            eventType: event.type,
            cause: Cause.pretty(cause),
          });
        }),
      );

  const worker = yield* makeDrainableWorker((input: RuntimeIngestionInput) =>
    processInput(input).pipe(logIngestionFailure(input.source, input.event)),
  );

  // Repository detection for a diff goes through VCS subprocesses, which can
  // stall behind slow or hung git. It runs on its own worker so a stuck diff
  // never delays the lifecycle worker; confirmed diffs are handed back to it.
  const detectProviderDiffRepository = Effect.fn("detectProviderDiffRepository")(function* (
    event: ProviderDiffEvent,
  ) {
    if (!toTurnId(event.turnId)) return;
    const checkpointContext = yield* projectionSnapshotQuery
      .getThreadCheckpointContext(event.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    const workspaceCwd = checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot;
    if (!workspaceCwd || !(yield* checkpointStore.isGitRepository(workspaceCwd))) return;
    yield* worker.enqueue({ source: "diff", event });
  });
  const diffWorker = yield* makeDrainableWorker((event: ProviderDiffEvent) =>
    detectProviderDiffRepository(event).pipe(logIngestionFailure("diff", event)),
  );

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        Stream.runForEach(providerService.streamEvents, (event) =>
          event.type === "turn.diff.updated"
            ? diffWorker.enqueue(event)
            : worker.enqueue({ source: "runtime", event }),
        ),
      );
      yield* forkParked(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );
    });

  return {
    start,
    // The diff worker feeds the lifecycle worker, so drain it first.
    drain: diffWorker.drain.pipe(Effect.andThen(worker.drain)),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(
  Layer.provide(ProjectionThreadActivityRepositoryLive),
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provide(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provide(ProjectionTurnRepositoryLive),
);
