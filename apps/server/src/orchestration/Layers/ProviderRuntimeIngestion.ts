import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  MessageId,
  type OrchestrationCheckpointFile,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { isReviewOutputText } from "@t3tools/shared/workflows/reviewOutput";
import {
  extractChangedFilePathCandidatesFromToolPayload,
  normalizeChangedFilePath,
} from "@t3tools/shared/toolChangedFiles";
import {
  Cache,
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import {
  latestCapturedCheckpointTurnCount,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { CheckoutCoordinator, CheckoutCoordinatorLive } from "../../git/CheckoutCoordinator.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { parseReviewResult } from "../reviewResult.ts";
import { ReviewSnapshotVerifier } from "../Services/ReviewSnapshotVerifier.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandIdFromEventId = (eventId: string, tag: string): CommandId =>
  CommandId.make(`provider:${eventId}:${tag}:${crypto.randomUUID()}`);
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  providerCommandIdFromEventId(event.eventId, tag);

interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

interface PendingStreamingDelta {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly eventId: string;
  readonly createdAt: string;
  text: string;
  /** UTF-8 byte length of `text`, tracked incrementally per appended delta. */
  textBytes: number;
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const STREAMING_DELTA_COALESCE_BYTES = 2_048;
const STREAMING_DELTA_FLUSH_INTERVAL = Duration.millis(50);
// A failed delta dispatch must not let a following terminal event (message
// completion, turn finalization) overtake the buffered text, so the ingestion
// worker retries the flush until it succeeds before processing that event.
const STREAMING_DELTA_STRICT_RETRY_DELAY = Duration.millis(25);
// Bound on strict-flush retry rounds so one poisoned message cannot stall the
// shared ingestion worker indefinitely; leftovers are salvaged into the
// finalize buffer instead of blocking later events for unrelated sessions.
const STREAMING_DELTA_STRICT_MAX_RETRY_ROUNDS = 400;

// Domain rejections that can never succeed on retry regardless of engine
// health. Matched by tag: Effect Schema error classes must be identified via
// their tag, not instanceof.
const PERMANENT_STREAMING_DELTA_DISPATCH_ERROR_TAGS: ReadonlySet<string> = new Set([
  "OrchestrationCommandJsonParseError",
  "OrchestrationCommandDecodeError",
  "OrchestrationCommandInvariantError",
  "OrchestrationCommandPreviouslyRejectedError",
  "OrchestrationCommandWorktreeCleanupPendingError",
]);

const hasPermanentStreamingDeltaDispatchFailure = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      reason._tag === "Fail" &&
      typeof reason.error === "object" &&
      reason.error !== null &&
      PERMANENT_STREAMING_DELTA_DISPATCH_ERROR_TAGS.has(
        (reason.error as { readonly _tag?: string })._tag ?? "",
      ),
  );
const RUNTIME_INGESTION_QUEUE_CAPACITY = 1_024;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type ProviderTurnDiffFile = OrchestrationCheckpointFile;

interface ProcessedEventReceiptState {
  readonly completed: ReadonlySet<string>;
  readonly waiters: ReadonlyMap<string, Deferred.Deferred<void>>;
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

function assistantTextDeltaFromEvent(
  event: ProviderRuntimeEvent,
): { readonly delta: string; readonly replaceExisting: boolean } | undefined {
  return event.type === "content.delta" && event.payload.streamKind === "assistant_text"
    ? {
        delta: event.payload.delta,
        replaceExisting: event.payload.replaceExisting === true,
      }
    : undefined;
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
  const baseKey = String(event.itemId ?? event.turnId ?? event.eventId);
  if (event.turnId !== undefined && baseKey.startsWith("assistant:")) {
    return `turn:${event.turnId}:item:${baseKey}`;
  }
  return baseKey;
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

function mergeProviderTurnDiffFiles(
  current: ReadonlyArray<ProviderTurnDiffFile>,
  next: ReadonlyArray<ProviderTurnDiffFile>,
): ProviderTurnDiffFile[] {
  const byPath = new Map<string, ProviderTurnDiffFile>();
  for (const file of current) {
    byPath.set(file.path, file);
  }
  for (const file of next) {
    byPath.set(file.path, file);
  }
  return [...byPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

function parseProviderTurnDiffFiles(
  unifiedDiff: string,
  cwd: string,
): ReadonlyArray<ProviderTurnDiffFile> {
  const parsedFiles = parseTurnDiffFilesFromUnifiedDiff(unifiedDiff);
  const result: ProviderTurnDiffFile[] = [];
  const seen = new Set<string>();

  for (const file of parsedFiles) {
    const normalizedPath = normalizeChangedFilePath(file.path, { cwd });
    if (normalizedPath === null || seen.has(normalizedPath)) {
      continue;
    }
    const normalizedPreviousPath =
      file.previousPath === null ? null : normalizeChangedFilePath(file.previousPath, { cwd });
    seen.add(normalizedPath);
    result.push({
      path: normalizedPath,
      ...(normalizedPreviousPath === null ? {} : { previousPath: normalizedPreviousPath }),
      kind: file.kind,
      additions: file.additions,
      deletions: file.deletions,
    });
  }

  return result;
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

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "turn.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "insights.turn.started",
          summary: "Turn started",
          payload: {
            provider: event.provider,
            ...(event.payload.model ? { model: event.payload.model } : {}),
            ...(event.payload.effort ? { effort: event.payload.effort } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.state === "failed" ? "error" : "info",
          kind: "insights.turn.completed",
          summary: "Turn completed",
          payload: {
            provider: event.provider,
            state: event.payload.state,
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.modelUsage !== undefined
              ? { modelUsage: event.payload.modelUsage }
              : {}),
            ...(event.payload.totalCostUsd !== undefined
              ? { totalCostUsd: event.payload.totalCostUsd }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.aborted": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "insights.turn.aborted",
          summary: "Turn aborted",
          payload: {
            provider: event.provider,
            ...(event.payload.reason ? { reason: event.payload.reason } : {}),
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

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
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
            ...(event.payload.name ? { name: event.payload.name } : {}),
            ...(event.payload.agentType ? { agentType: event.payload.agentType } : {}),
            ...(event.payload.prompt ? { prompt: event.payload.prompt } : {}),
            ...(event.payload.model ? { model: event.payload.model } : {}),
            ...(event.payload.reasoningEffort
              ? { reasoningEffort: event.payload.reasoningEffort }
              : {}),
            ...(event.payload.launchToolCallId
              ? { launchToolCallId: event.payload.launchToolCallId }
              : {}),
            ...(event.payload.description
              ? { description: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
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
            // `detail` stays a short preview for compact inline work-log rows, while `summary`
            // preserves the full final result so the read-only agent-run view can render it in full.
            ...(event.payload.summary
              ? { detail: truncateDetail(event.payload.summary), summary: event.payload.summary }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
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

      const { beforeTokens, afterTokens } = event.payload;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary:
            beforeTokens !== undefined && afterTokens !== undefined
              ? `Compacted context ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens`
              : "Compacted context",
          payload: {
            state: event.payload.state,
            ...(beforeTokens !== undefined ? { beforeTokens } : {}),
            ...(afterTokens !== undefined ? { afterTokens } : {}),
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
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.itemId ? { itemId: event.itemId } : {}),
            provider: event.provider,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
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
            ...(event.itemId ? { itemId: event.itemId } : {}),
            provider: event.provider,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
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
            ...(event.itemId ? { itemId: event.itemId } : {}),
            provider: event.provider,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
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
  const coordinator = yield* CheckoutCoordinator;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const processedEventReceipts = yield* SynchronizedRef.make<ProcessedEventReceiptState>({
    completed: new Set(),
    waiters: new Map(),
  });
  const projectedToolUpdateStatuses = new Map<string, string>();

  const toolUpdateKey = (event: Extract<ProviderRuntimeEvent, { type: "item.updated" }>) =>
    event.itemId === undefined
      ? undefined
      : `${event.threadId}\u0000${event.turnId ?? ""}\u0000${event.itemId}`;

  const shouldProjectToolUpdate = (
    event: Extract<ProviderRuntimeEvent, { type: "item.updated" }>,
  ): boolean => {
    const key = toolUpdateKey(event);
    if (key === undefined) {
      return true;
    }
    const changedPaths = extractChangedFilePathCandidatesFromToolPayload(event.payload.data, {
      maxDepth: 4,
      maxPaths: 64,
    });
    const fingerprint = `${event.payload.status ?? ""}\u0000${changedPaths.join("\u0000")}`;
    if (projectedToolUpdateStatuses.get(key) === fingerprint) {
      return false;
    }
    projectedToolUpdateStatuses.set(key, fingerprint);
    return true;
  };

  const clearProjectedToolUpdate = (event: ProviderRuntimeEvent, terminalTurnId?: TurnId): void => {
    if (event.type === "item.completed" && event.itemId !== undefined) {
      projectedToolUpdateStatuses.delete(
        `${event.threadId}\u0000${event.turnId ?? ""}\u0000${event.itemId}`,
      );
      return;
    }
    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const prefix = `${event.threadId}\u0000${terminalTurnId ?? event.turnId ?? ""}\u0000`;
      for (const key of projectedToolUpdateStatuses.keys()) {
        if (key.startsWith(prefix)) {
          projectedToolUpdateStatuses.delete(key);
        }
      }
    }
  };

  const awaitTurnCompletionProcessed: ProviderRuntimeIngestionShape["awaitTurnCompletionProcessed"] =
    (eventId) =>
      Effect.gen(function* () {
        const createdWaiter = yield* Deferred.make<void>();
        const waiter = yield* SynchronizedRef.modify(
          processedEventReceipts,
          (state): readonly [Deferred.Deferred<void> | undefined, ProcessedEventReceiptState] => {
            const key = String(eventId);
            if (state.completed.has(key)) {
              const completed = new Set(state.completed);
              completed.delete(key);
              return [undefined, { ...state, completed }];
            }
            const existingWaiter = state.waiters.get(key);
            if (existingWaiter !== undefined) {
              return [existingWaiter, state];
            }
            const waiters = new Map(state.waiters);
            waiters.set(key, createdWaiter);
            return [createdWaiter, { ...state, waiters }];
          },
        );
        if (waiter !== undefined) {
          yield* Deferred.await(waiter);
        }
      });

  const markProcessed = (event: ProviderRuntimeEvent) =>
    event.type !== "turn.completed" || event.turnId === undefined
      ? Effect.void
      : Effect.gen(function* () {
          const waiter = yield* SynchronizedRef.modify(
            processedEventReceipts,
            (state): readonly [Deferred.Deferred<void> | undefined, ProcessedEventReceiptState] => {
              const key = String(event.eventId);
              if (state.completed.has(key)) {
                return [undefined, state];
              }
              const waiters = new Map(state.waiters);
              const pending = waiters.get(key);
              waiters.delete(key);

              const completed = new Set(state.completed);
              if (pending === undefined) {
                completed.add(key);
              }
              return [pending, { completed, waiters }];
            },
          );
          if (waiter !== undefined) {
            yield* Deferred.succeed(waiter, undefined);
          }
        });
  const reviewSnapshotVerifier = yield* ReviewSnapshotVerifier;

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

  // Coalescing buffer for streaming-mode assistant deltas: deltas accumulate per
  // message and are dispatched as one command on a size threshold, a time window,
  // or before any non-delta event is processed (which preserves ordering with
  // completion/finalization commands).
  const pendingStreamingDeltas = yield* Ref.make<Map<MessageId, PendingStreamingDelta>>(new Map());
  const streamingDeltaFlushLock = yield* Semaphore.make(1);

  const takePendingStreamingDelta = (messageId: MessageId) =>
    Ref.modify(
      pendingStreamingDeltas,
      (
        map,
      ): readonly [PendingStreamingDelta | undefined, Map<MessageId, PendingStreamingDelta>] => {
        const entry = map.get(messageId);
        if (entry === undefined) {
          return [undefined, map];
        }
        const next = new Map(map);
        next.delete(messageId);
        return [entry, next];
      },
    );

  // Puts undelivered text back at the front of the buffer so a failed dispatch
  // is retried by the next flush instead of silently dropping streamed text.
  const restorePendingStreamingDelta = (messageId: MessageId, pending: PendingStreamingDelta) =>
    Ref.update(pendingStreamingDeltas, (map) => {
      const existing = map.get(messageId);
      const next = new Map(map);
      next.set(
        messageId,
        existing === undefined
          ? pending
          : {
              ...existing,
              text: `${pending.text}${existing.text}`,
              textBytes: pending.textBytes + existing.textBytes,
            },
      );
      return next;
    });

  const flushStreamingDeltaForMessage = (messageId: MessageId) =>
    streamingDeltaFlushLock.withPermits(1)(
      Effect.gen(function* () {
        const pending = yield* takePendingStreamingDelta(messageId);
        if (pending === undefined || pending.text.length === 0) {
          return;
        }
        yield* orchestrationEngine
          .dispatch({
            type: "thread.message.assistant.delta",
            // Deterministic per buffered batch (no random suffix): if this
            // dispatch committed and its caller was still interrupted, the
            // engine's command receipt deduplicates the retry instead of
            // appending the same text twice.
            commandId: CommandId.make(`provider:${pending.eventId}:assistant-delta`),
            threadId: pending.threadId,
            messageId,
            delta: pending.text,
            ...(pending.turnId !== undefined ? { turnId: pending.turnId } : {}),
            createdAt: pending.createdAt,
          })
          .pipe(
            // An interrupt observed mid-dispatch is ambiguous: the engine may
            // have committed. Making the dispatch itself uninterruptible
            // removes that window — external interruption waits until the
            // dispatch settles, so restore-on-interrupt below only runs for
            // dispatches that provably did not commit.
            Effect.uninterruptible,
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                // The batch is already removed from the buffer; restore it so
                // a later flusher or the shutdown finalizer can still deliver
                // text an interrupted in-flight dispatch took out.
                return Effect.flatMap(restorePendingStreamingDelta(messageId, pending), () =>
                  Effect.failCause(cause),
                );
              }
              if (hasPermanentStreamingDeltaDispatchFailure(cause)) {
                // Retrying can never succeed. Hand the text to the finalize
                // buffer instead of restoring it: the next terminal event for
                // this message carries it to completion, and ingestion never
                // wedges on a permanently rejected delta dispatch.
                return Effect.flatMap(appendBufferedAssistantText(messageId, pending.text), () =>
                  Effect.logError(
                    "provider runtime ingestion gave up dispatching coalesced streaming delta; text deferred to message finalization",
                    { messageId, cause: Cause.pretty(cause) },
                  ),
                );
              }
              return Effect.gen(function* () {
                yield* restorePendingStreamingDelta(messageId, pending);
                yield* Effect.logWarning(
                  "provider runtime ingestion failed to dispatch coalesced streaming delta",
                  { messageId, cause: Cause.pretty(cause) },
                );
              });
            }),
          );
      }),
    );

  const flushAllStreamingDeltas = () =>
    Effect.gen(function* () {
      const messageIds = Array.from((yield* Ref.get(pendingStreamingDeltas)).keys());
      for (const messageId of messageIds) {
        yield* flushStreamingDeltaForMessage(messageId);
      }
    }).pipe(Effect.asVoid);

  const hasPendingStreamingDeltas = Effect.map(
    Ref.get(pendingStreamingDeltas),
    (map) => map.size > 0,
  );

  // Last-resort salvage for buffers that keep failing transiently: move their
  // text into the finalize buffer under the flush lock (excluding concurrent
  // restores) so the upcoming terminal event still delivers it.
  const salvageAllPendingStreamingDeltas = streamingDeltaFlushLock.withPermits(1)(
    Effect.gen(function* () {
      const remaining = yield* Ref.getAndSet(pendingStreamingDeltas, new Map());
      const entries = Array.from(remaining.entries());
      if (entries.length === 0) {
        return;
      }
      for (const [messageId, pending] of entries) {
        yield* appendBufferedAssistantText(messageId, pending.text);
      }
      yield* Effect.logWarning(
        "provider runtime ingestion deferred persistently failing streaming deltas to message finalization",
        { messageIds: entries.map(([messageId]) => messageId) },
      );
    }),
  );

  // Ordering-critical flush: used before terminal events. A transient engine
  // failure must not let the terminal event overtake buffered text, so retry
  // until every buffer is delivered — bounded so one poisoned message cannot
  // wedge the shared ingestion worker forever; leftovers are salvaged into
  // the finalize buffer rather than dropped.
  const flushAllStreamingDeltasStrictly = Effect.gen(function* () {
    yield* flushAllStreamingDeltas();
    let rounds = 0;
    while ((yield* hasPendingStreamingDeltas) && rounds < STREAMING_DELTA_STRICT_MAX_RETRY_ROUNDS) {
      yield* Effect.sleep(STREAMING_DELTA_STRICT_RETRY_DELAY);
      yield* flushAllStreamingDeltas();
      rounds += 1;
    }
    if (yield* hasPendingStreamingDeltas) {
      yield* salvageAllPendingStreamingDeltas;
    }
  }).pipe(Effect.asVoid);

  const appendStreamingAssistantDelta = (input: {
    threadId: ThreadId;
    messageId: MessageId;
    turnId: TurnId | undefined;
    eventId: string;
    delta: string;
    createdAt: string;
  }) =>
    Ref.modify(
      pendingStreamingDeltas,
      (map): readonly [boolean, Map<MessageId, PendingStreamingDelta>] => {
        const existing = map.get(input.messageId);
        const text = `${existing?.text ?? ""}${input.delta}`;
        const next = new Map(map);
        next.set(input.messageId, {
          threadId: input.threadId,
          turnId: input.turnId,
          eventId: input.eventId,
          createdAt: input.createdAt,
          text,
          // Compare UTF-8 bytes against the byte-named threshold; code-unit
          // lengths understate multi-byte content by up to 3x per character.
          textBytes: (existing?.textBytes ?? 0) + Buffer.byteLength(input.delta, "utf8"),
        });
        return [next.get(input.messageId)!.textBytes >= STREAMING_DELTA_COALESCE_BYTES, next];
      },
    ).pipe(
      Effect.flatMap((shouldSpill) =>
        shouldSpill ? flushStreamingDeltaForMessage(input.messageId) : Effect.void,
      ),
    );

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

  const resolveGitRepositoryCwdForThread = Effect.fn("resolveGitRepositoryCwdForThread")(function* (
    threadId: ThreadId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return null;
    }
    const workspaceCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!workspaceCwd) {
      return null;
    }
    return isGitRepository(workspaceCwd) ? workspaceCwd : null;
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
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState);
          return nextState.activeMessageId!;
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

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

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
        commandId: providerCommandId(input.event, input.commandTag),
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
          commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
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
          commandId: providerCommandId(input.event, input.commandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const persistReviewResult = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
  }) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === input.threadId);
      if (!thread?.reviewSnapshot) {
        return;
      }
      const reviewSnapshot = thread.reviewSnapshot;
      const output =
        thread.messages
          .filter(
            (message) =>
              message.role === "assistant" && message.turnId === input.turnId && !message.streaming,
          )
          .toSorted(
            (left, right) =>
              left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
          )
          .at(-1)?.text ?? "";
      // Review threads stay conversational after the first result. Only turns
      // that produced reviewer output may replace an existing result, so an
      // ordinary follow-up reply cannot wipe the findings card.
      if (
        thread.reviewResult !== undefined &&
        thread.reviewResult !== null &&
        !isReviewOutputText(output)
      ) {
        return;
      }
      const cwd = resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      });
      if (cwd == null) {
        yield* Effect.logWarning("Discarding review result because the worktree is unavailable", {
          threadId: input.threadId,
          snapshotHash: reviewSnapshot.diffHash,
        });
        return;
      }
      // The reviewer inspects the working tree live, so anchor its findings to
      // the diff as it stands now rather than the snapshot taken at thread
      // creation, which is stale once the user pushes fixes and re-reviews.
      const snapshot = yield* reviewSnapshotVerifier
        .currentSnapshot({ cwd, snapshot: reviewSnapshot })
        .pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Discarding review result because the diff could not be resolved", {
              threadId: input.threadId,
              snapshotHash: reviewSnapshot.diffHash,
              error,
            }),
          ),
          Effect.orElseSucceed(() => null),
        );
      if (snapshot === null) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.review-result.set",
        commandId: providerCommandId(input.event, "review-result-set"),
        threadId: input.threadId,
        result: parseReviewResult({ output, snapshot }),
        createdAt: input.createdAt,
      });
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

      const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert"),
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
      const readModel = yield* orchestrationEngine.getReadModel();
      const sourceThread = readModel.threads.find((entry) => entry.id === sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
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
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.threadId);
      if (!thread) return;

      if (event.type === "turn.completed" && event.turnId !== undefined) {
        const cwd =
          thread.worktreePath ??
          readModel.projects.find((project) => project.id === thread.projectId)?.workspaceRoot;
        if (cwd) {
          // Establish exclusion before any command can publish an idle session.
          // The owned checkpoint handoff releases it after terminal processing.
          yield* coordinator.beginFinalization(event.eventId, cwd);
        }
        const runtimeSession = (yield* providerService.listSessions()).find(
          (session) => session.threadId === thread.id,
        );
        if (runtimeSession?.cwd) {
          yield* coordinator.beginFinalization(event.eventId, runtimeSession.cwd);
        }
      }

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const lifecycleTurnId =
        (event.type === "turn.completed" || event.type === "turn.aborted") &&
        eventTurnId === undefined
          ? (activeTurnId ??
            (event.type === "turn.aborted" && thread.latestTurn?.state === "interrupted"
              ? thread.latestTurn.turnId
              : undefined))
          : eventTurnId;

      const matchesActiveTurn =
        activeTurnId !== null &&
        lifecycleTurnId !== undefined &&
        sameId(activeTurnId, lifecycleTurnId);
      const conflictsWithActiveTurn =
        activeTurnId !== null && lifecycleTurnId !== undefined && !matchesActiveTurn;
      const matchesExpectedInterruptedTurn =
        lifecycleTurnId !== undefined &&
        thread.latestTurn?.state === "interrupted" &&
        sameId(thread.latestTurn.turnId, lifecycleTurnId);
      const wasTurnAborted =
        event.type === "turn.completed" && lifecycleTurnId !== undefined
          ? yield* projectionThreadActivityRepository.hasKindForTurn({
              threadId: thread.id,
              turnId: lifecycleTurnId,
              kind: "insights.turn.aborted",
            })
          : false;
      const isDuplicateCompletionAfterInterruption =
        event.type === "turn.completed" && wasTurnAborted;

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
            return !conflictsWithActiveTurn;
          case "turn.completed":
            if (isDuplicateCompletionAfterInterruption) {
              return false;
            }
            if (conflictsWithActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && lifecycleTurnId !== undefined) {
              return sameId(activeTurnId, lifecycleTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          case "turn.aborted":
            return matchesActiveTurn;
          default:
            return true;
        }
      })();
      const shouldFinalizeTerminalTurn =
        (event.type === "turn.completed" && !isDuplicateCompletionAfterInterruption) ||
        (event.type === "turn.aborted" &&
          (!STRICT_PROVIDER_LIFECYCLE_GUARD ||
            matchesActiveTurn ||
            matchesExpectedInterruptedTurn));
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      const isThreadLifecycleEvent =
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted";
      const dispatchThreadLifecycleUpdate = () =>
        Effect.gen(function* () {
          if (!isThreadLifecycleEvent || !shouldApplyThreadLifecycle) {
            return;
          }

          const nextActiveTurnId =
            event.type === "turn.started"
              ? (lifecycleTurnId ?? null)
              : event.type === "turn.completed" ||
                  event.type === "turn.aborted" ||
                  event.type === "session.exited"
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
              case "turn.aborted":
                return "interrupted";
              case "session.started":
              case "thread.started":
                // Provider thread/session start notifications can arrive during an
                // active turn; preserve turn-running state in that case.
                return activeTurnId !== null ? "running" : "ready";
            }
          })();
          const lastError =
            event.type === "session.state.changed" && event.payload.state === "error"
              ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
              : event.type === "turn.completed" &&
                  normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
                : event.type === "turn.aborted"
                  ? (thread.session?.lastError ?? null)
                  : status === "ready"
                    ? null
                    : (thread.session?.lastError ?? null);

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
            commandId: providerCommandId(event, "thread-session-set"),
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
              ...(thread.session?.resumeCursor !== undefined
                ? { resumeCursor: thread.session.resumeCursor }
                : {}),
              lastError,
              updatedAt: now,
            },
            ...(event.type === "turn.aborted" && lifecycleTurnId !== undefined
              ? { expectedActiveTurnId: lifecycleTurnId }
              : {}),
            createdAt: now,
          });
        });

      if (isThreadLifecycleEvent) {
        if (shouldFinalizeTerminalTurn) {
          const terminalTurnId = lifecycleTurnId;
          if (terminalTurnId) {
            const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
              thread.id,
              terminalTurnId,
            );
            yield* Effect.forEach(
              assistantMessageIds,
              (assistantMessageId) =>
                finalizeAssistantMessage({
                  event,
                  threadId: thread.id,
                  messageId: assistantMessageId,
                  turnId: terminalTurnId,
                  createdAt: now,
                  commandTag: "assistant-complete-finalize",
                  finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                  hasProjectedMessage: thread.messages.some(
                    (entry) => entry.id === assistantMessageId,
                  ),
                }),
              { concurrency: 1 },
            ).pipe(Effect.asVoid);
            yield* clearAssistantMessageIdsForTurn(thread.id, terminalTurnId);
            yield* clearAssistantSegmentStateForTurn(thread.id, terminalTurnId);

            if (event.type === "turn.completed") {
              yield* finalizeBufferedProposedPlan({
                event,
                threadId: thread.id,
                threadProposedPlans: thread.proposedPlans,
                planId: proposedPlanIdForTurn(thread.id, terminalTurnId),
                turnId: terminalTurnId,
                updatedAt: now,
              });
            }
          }
        }

        if (event.type === "turn.completed" && !isDuplicateCompletionAfterInterruption) {
          yield* Effect.forEach(
            runtimeEventToActivities(
              event.turnId === undefined && lifecycleTurnId !== undefined
                ? { ...event, turnId: lifecycleTurnId }
                : event,
            ),
            (activity) =>
              orchestrationEngine.dispatch({
                type: "thread.activity.append",
                commandId: providerCommandId(event, "thread-activity-append"),
                threadId: thread.id,
                activity,
                createdAt: activity.createdAt,
              }),
          ).pipe(Effect.asVoid);
        }

        yield* dispatchThreadLifecycleUpdate();
        if (event.type === "turn.completed" && lifecycleTurnId !== undefined) {
          yield* persistReviewResult({
            event,
            threadId: thread.id,
            turnId: lifecycleTurnId,
            createdAt: now,
          });
        }
      }

      if (
        (event.type === "request.opened" ||
          event.type === "request.resolved" ||
          event.type === "user-input.requested" ||
          event.type === "user-input.resolved") &&
        eventTurnId !== undefined &&
        thread.session?.status !== "stopped" &&
        (!STRICT_PROVIDER_LIFECYCLE_GUARD ||
          activeTurnId === null ||
          sameId(activeTurnId, eventTurnId))
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "request-lifecycle-session-set"),
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
            ...(thread.session?.resumeCursor !== undefined
              ? { resumeCursor: thread.session.resumeCursor }
              : {}),
            lastError: thread.session?.lastError ?? null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      const assistantTextUpdate = assistantTextDeltaFromEvent(event);
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantTextUpdate && assistantTextUpdate.delta.length > 0) {
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
        if (assistantTextUpdate.replaceExisting) {
          yield* streamingDeltaFlushLock.withPermits(1)(
            Effect.gen(function* () {
              yield* takePendingStreamingDelta(assistantMessageId);
              yield* clearBufferedAssistantText(assistantMessageId);
              yield* orchestrationEngine.dispatch({
                type: "thread.message.assistant.delta",
                commandId: providerCommandId(event, "assistant-delta-replace"),
                threadId: thread.id,
                messageId: assistantMessageId,
                delta: assistantTextUpdate.delta,
                replaceExisting: true,
                ...(turnId ? { turnId } : {}),
                createdAt: now,
              });
            }),
          );
        } else if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(
            assistantMessageId,
            assistantTextUpdate.delta,
          );
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* appendStreamingAssistantDelta({
            threadId: thread.id,
            messageId: assistantMessageId,
            turnId,
            eventId: event.eventId,
            delta: assistantTextUpdate.delta,
            createdAt: now,
          });
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
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
          hasProjectedMessage: thread.messages.some(
            (entry) =>
              entry.role === "assistant" && entry.turnId === pauseForUserTurnId && entry.streaming,
          ),
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
              messageId: assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(event), 0),
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
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const hasAssistantMessagesForTurn =
          turnId !== undefined
            ? thread.messages.some((entry) => entry.role === "assistant" && entry.turnId === turnId)
            : false;
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const existingAssistantMessage = thread.messages.find(
          (entry) => entry.id === assistantMessageId,
        );
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
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
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
            commandId: providerCommandId(event, "runtime-error-session-set"),
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
              ...(thread.session?.resumeCursor !== undefined
                ? { resumeCursor: thread.session.resumeCursor }
                : {}),
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
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const workspaceCwd = yield* resolveGitRepositoryCwdForThread(thread.id);
        if (turnId && workspaceCwd !== null) {
          const existingCheckpoint = thread.checkpoints.find((c) => c.turnId === turnId);
          if (
            existingCheckpoint !== undefined &&
            existingCheckpoint.status !== "missing" &&
            existingCheckpoint.status !== "speculative"
          ) {
            // A real capture from CheckpointReactor should not be clobbered by
            // subsequent provider diff updates for the same turn.
          } else {
            const providerTurnFiles = parseProviderTurnDiffFiles(
              event.payload.unifiedDiff,
              workspaceCwd,
            );
            const turnFiles =
              existingCheckpoint === undefined
                ? providerTurnFiles
                : mergeProviderTurnDiffFiles(existingCheckpoint.turnFiles, providerTurnFiles);
            const agentTouchedPaths = [...new Set(turnFiles.map((file) => file.path))];
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            const maxTurnCount = latestCapturedCheckpointTurnCount(thread.checkpoints);
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef:
                existingCheckpoint?.checkpointRef ??
                CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "speculative",
              files: [],
              agentTouchedPaths,
              turnFiles,
              assistantMessageId,
              checkpointTurnCount: existingCheckpoint?.checkpointTurnCount ?? maxTurnCount + 1,
              createdAt: now,
            });
          }
        }
      }

      const activities = isDuplicateCompletionAfterInterruption
        ? []
        : event.type === "turn.completed"
          ? []
          : event.type === "item.updated" && !shouldProjectToolUpdate(event)
            ? []
            : runtimeEventToActivities(
                event.type === "turn.aborted" &&
                  event.turnId === undefined &&
                  lifecycleTurnId !== undefined
                  ? { ...event, turnId: lifecycleTurnId }
                  : event,
              );
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append"),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
      clearProjectedToolUpdate(event, lifecycleTurnId);
    });

  const processRuntimeEventSafely = (event: ProviderRuntimeEvent) =>
    processRuntimeEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          eventId: event.eventId,
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const isAssistantTextDeltaEvent = (event: ProviderRuntimeEvent): boolean =>
    assistantTextDeltaFromEvent(event) !== undefined;

  const worker = yield* makeDrainableWorker(
    ({
      event,
      enqueueCheckpointEvent,
    }: {
      event: ProviderRuntimeEvent;
      enqueueCheckpointEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    }) =>
      Effect.gen(function* () {
        let handedOff = false;
        yield* Effect.andThen(
          // Non-delta events may finalize or complete a message, so any buffered
          // deltas must reach the engine first to preserve ordering. The strict
          // variant retries through transient dispatch failures instead of
          // letting a completion overtake undelivered text.
          isAssistantTextDeltaEvent(event) ? Effect.void : flushAllStreamingDeltasStrictly,
          processRuntimeEventSafely(event),
        ).pipe(
          Effect.andThen(markProcessed(event)),
          Effect.andThen(
            enqueueCheckpointEvent(event).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  handedOff = true;
                }),
              ),
              Effect.uninterruptible,
            ),
          ),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !handedOff
              ? coordinator.endFinalization(event.eventId)
              : Effect.void,
          ),
        );
      }),
    {
      capacity: RUNTIME_INGESTION_QUEUE_CAPACITY,
    },
  );

  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(STREAMING_DELTA_FLUSH_INTERVAL).pipe(
        Effect.andThen(flushAllStreamingDeltas()),
        // An interrupted in-flight flush must not kill the flusher fiber: the
        // batch is restored by the flush itself and the next tick retries.
        // Shutdown still ends this loop through its own scope interruption.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("periodic streaming delta flush failed", {
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    ),
  );

  yield* Effect.addFinalizer(() =>
    flushAllStreamingDeltas().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning(
              "provider runtime ingestion failed to flush streaming deltas on shutdown",
              { cause: Cause.pretty(cause) },
            ),
      ),
    ),
  );

  const start: ProviderRuntimeIngestionShape["start"] = (enqueueCheckpointEvent) =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          worker.enqueue({ event, enqueueCheckpointEvent }),
        ),
      );
    });

  return {
    start,
    drain: worker.drain,
    awaitTurnCompletionProcessed,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(CheckoutCoordinatorLive),
);
