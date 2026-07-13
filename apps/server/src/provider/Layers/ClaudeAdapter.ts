/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type CanUseTool,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKControlGetContextUsageResponse,
  type SDKResultMessage,
  type SettingSource,
  type SDKUserMessage,
  type ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ClaudeSettings,
  type ModelCapabilities,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeUsageLimitDetail,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import {
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
} from "./ClaudeProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { detectClaudeUsageLimit, isUsageLimitDetail } from "../UsageLimit.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);

const DEFAULT_CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;
type ClaudeSdkEffort = NonNullable<ClaudeQueryOptions["effort"]>;
type ClaudeModelCapabilitiesLookup = (model: string | undefined) => ModelCapabilities | undefined;
type ClaudeEffortNormalizer = (
  effort: string | null | undefined,
  model: string | null | undefined,
) => string | undefined;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  /**
   * True for turns auto-started by assistant output arriving without an
   * active turn (background agent/subagent responses between user prompts).
   * Synthetic turns are auto-closed by the next sendTurn; real turns are
   * steered instead (the queued message continues the same turn).
   */
  readonly synthetic?: boolean;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  nextSyntheticAssistantBlockIndex: number;
}

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

interface ClaudeTaskState {
  readonly id: string;
  subject: string;
  status: PlanStep["status"];
  readonly blockedBy: Set<string>;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  currentApiModelId: string | undefined;
  resumeSessionId: string | undefined;
  /**
   * When true, the next user prompt should include a one-shot note that
   * background shells/tasks from before the resume are dead. Only set when
   * the SDK query was started with `resume:`.
   */
  pendingResumeDeadShellNote: boolean;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  /**
   * Assistant Task/Agent tool_use id → parsed tool input. Used to resolve
   * an explicit subagent model override from Task tool input (SDK task_*
   * messages do not carry model). Pruned when the correlated task reaches
   * a terminal state, when closed/orphan entries are pruned at turn end, and
   * on session stop. Open-task entries survive normal turn completion so
   * background subagent messages can still be correlated across turns.
   */
  readonly taskToolInputsByUseId: Map<string, Record<string, unknown>>;
  /** task_id → tool_use_id for pruning taskToolInputsByUseId on terminal. */
  readonly taskToolUseIdByTaskId: Map<string, string>;
  /**
   * task_id → last known authoritative model (Task tool input override and/or
   * mined from subagent assistant messages). Used to emit task.updated only
   * when the model changes. Survives normal turn completion while the task
   * remains open (backgrounded subagents).
   */
  readonly taskModelByTaskId: Map<string, string>;
  /** task_id values that have started but not yet completed/stopped. */
  readonly openTaskIds: Set<string>;
  /**
   * Tasks for which we already emitted a synthetic `task.completed`
   * status `"stopped"` (stopTask grace / session close). Native terminal
   * events for these ids are suppressed so a delayed SDK completion cannot
   * flip the UI back to completed or double-emit.
   */
  readonly syntheticallyStoppedTaskIds: Set<string>;
  readonly claudeTasks: Map<string, ClaudeTaskState>;
  claudeTaskPlanFingerprint: string | undefined;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastKnownTotalProcessedTokens: number | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  pendingUsageLimit: RuntimeUsageLimitDetail | undefined;
  stopped: boolean;
}

/** SDK task_updated statuses that mean the task is terminal. */
function isTerminalTaskUpdatedStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly stopTask: (taskId: string) => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly getContextUsage?: () => Promise<SDKControlGetContextUsageResponse>;
  readonly close: () => void;
}

/** How long to wait for the SDK's own terminal task event after stopTask. */
const STOP_TASK_TERMINAL_GRACE = Duration.seconds(3);

export interface ClaudeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly driverKind?: ProviderDriverKind;
  readonly environment?: NodeJS.ProcessEnv;
  readonly getModelCapabilities?: ClaudeModelCapabilitiesLookup;
  readonly normalizeEffort?: ClaudeEffortNormalizer;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

function hasDurableClaudeSessionId(message: SDKMessage): boolean {
  if (message.type !== "system") {
    return true;
  }

  return (
    message.subtype !== "hook_started" &&
    message.subtype !== "hook_progress" &&
    message.subtype !== "hook_response"
  );
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function normalizeClaudeStreamMessages(
  cause: Cause.Cause<ProviderAdapterProcessError>,
): ReadonlyArray<string> {
  const errors: Array<string> = [];
  for (const error of Cause.prettyErrors(cause)) {
    const message = error.message.trim();
    if (message.length > 0) {
      errors.push(message);
    }
  }
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function getEffectiveClaudeAgentEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
  normalizeEffort: ClaudeEffortNormalizer = normalizeClaudeCliEffort,
): ClaudeSdkEffort | null {
  const normalized = normalizeEffort(effort, model);
  return normalized ? (normalized as ClaudeSdkEffort) : null;
}

function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

function isClaudeInterruptedCause(cause: Cause.Cause<ProviderAdapterProcessError>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage) ||
    cause.reasons.some(
      (reason) =>
        Cause.isFailReason(reason) && isClaudeInterruptedMessage(toMessage(reason.error.cause, "")),
    )
  );
}

function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.make(value);
}

function maxClaudeContextWindowFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage)) {
    const contextWindow = value.contextWindow;
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

function selectedClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
  getModelCapabilities: ClaudeModelCapabilitiesLookup = getClaudeModelCapabilities,
): number | undefined {
  switch (modelSelection?.model) {
    case "claude-opus-4-8":
    case "claude-opus-4-7":
      return 1_000_000;
  }

  const optionValue = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  if (optionValue === "1m") {
    return 1_000_000;
  }
  if (optionValue === "200k") {
    return 200_000;
  }
  const caps =
    getModelCapabilities(modelSelection?.model) ??
    getClaudeModelCapabilities(modelSelection?.model);
  const hasContextWindowOption = getProviderOptionDescriptors({ caps }).some(
    (descriptor) => descriptor.type === "select" && descriptor.id === "contextWindow",
  );
  if (hasContextWindowOption) {
    return 200_000;
  }
  return undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function claudeUsageInputTokens(usage: Record<string, unknown>): number {
  return (
    (finiteNonNegativeInteger(usage.input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_creation_input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_read_input_tokens) ?? 0)
  );
}

function claudeUsageOutputTokens(usage: Record<string, unknown>): number {
  return finiteNonNegativeInteger(usage.output_tokens) ?? 0;
}

function lastClaudeUsageIteration(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const iterations = Array.isArray(value.iterations) ? value.iterations : [];
  return iterations.findLast(
    (iteration): iteration is Record<string, unknown> =>
      iteration !== null && typeof iteration === "object" && !Array.isArray(iteration),
  );
}

function claudeTotalProcessedTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const explicitTotal = finiteNonNegativeInteger(usage.total_tokens);
  if (explicitTotal !== undefined && explicitTotal > 0) {
    return explicitTotal;
  }

  const total = claudeUsageInputTokens(usage) + claudeUsageOutputTokens(usage);
  return total > 0 ? total : undefined;
}

function makeClaudeTokenUsageSnapshot(input: {
  readonly activeTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly contextWindow?: number;
  readonly totalProcessedTokens?: number;
  readonly lastUsedTokens?: number;
  readonly compactsAutomatically?: boolean;
}): ThreadTokenUsageSnapshot | undefined {
  const activeTokens = finiteNonNegativeInteger(input.activeTokens);
  if (activeTokens === undefined || activeTokens <= 0) {
    return undefined;
  }

  const maxTokens = finitePositiveInteger(input.contextWindow);
  const usedTokens = maxTokens !== undefined ? Math.min(activeTokens, maxTokens) : activeTokens;
  const lastUsedTokens =
    finiteNonNegativeInteger(input.lastUsedTokens) ??
    (maxTokens !== undefined ? Math.min(activeTokens, maxTokens) : activeTokens);
  const totalProcessedTokens = finiteNonNegativeInteger(input.totalProcessedTokens);
  const inputTokens = finiteNonNegativeInteger(input.inputTokens);
  const outputTokens = finiteNonNegativeInteger(input.outputTokens);

  return {
    usedTokens,
    lastUsedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input.compactsAutomatically !== undefined
      ? { compactsAutomatically: input.compactsAutomatically }
      : {}),
  };
}

function normalizeClaudeActiveTokenUsage(
  value: unknown,
  contextWindow?: number,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const activeUsage = lastClaudeUsageIteration(usage) ?? usage;
  const inputTokens = claudeUsageInputTokens(activeUsage);
  const outputTokens = claudeUsageOutputTokens(activeUsage);
  const activeTokens = claudeTotalProcessedTokens(activeUsage) ?? inputTokens + outputTokens;
  if (activeTokens <= 0) {
    return undefined;
  }

  return makeClaudeTokenUsageSnapshot({
    activeTokens,
    inputTokens,
    outputTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
  });
}

function normalizeClaudeContextUsageApiSnapshot(
  value: SDKControlGetContextUsageResponse,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined {
  return makeClaudeTokenUsageSnapshot({
    activeTokens: value.totalTokens,
    contextWindow: value.maxTokens,
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
    compactsAutomatically: value.isAutoCompactEnabled,
  });
}

function compactBoundaryTokenUsageSnapshot(
  message: Record<string, unknown>,
  contextWindow?: number,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined {
  const metadata = message.compact_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const compactMetadata = metadata as Record<string, unknown>;
  const postTokens = finiteNonNegativeInteger(compactMetadata.post_tokens);
  if (postTokens === undefined || postTokens <= 0) {
    return undefined;
  }

  const preTokens = finiteNonNegativeInteger(compactMetadata.pre_tokens);
  return makeClaudeTokenUsageSnapshot({
    activeTokens: postTokens,
    ...(preTokens !== undefined ? { lastUsedTokens: preTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
  });
}

function normalizeClaudeTaskProgressTokenUsage(
  value: unknown,
  context: ClaudeSessionContext,
): ThreadTokenUsageSnapshot | undefined {
  const totalTokens = claudeTotalProcessedTokens(value);
  if (totalTokens === undefined || totalTokens <= 0) {
    return undefined;
  }

  const lastUsedTokens = context.lastKnownTokenUsage?.usedTokens;
  const activeTokens =
    lastUsedTokens !== undefined ? Math.max(totalTokens, lastUsedTokens) : totalTokens;
  if (lastUsedTokens !== undefined && activeTokens === lastUsedTokens) {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const snapshot = makeClaudeTokenUsageSnapshot({
    activeTokens,
    ...(context.lastKnownContextWindow !== undefined
      ? { contextWindow: context.lastKnownContextWindow }
      : {}),
    totalProcessedTokens: Math.max(
      totalTokens,
      context.lastKnownTotalProcessedTokens ?? totalTokens,
    ),
  });
  if (!snapshot) {
    return undefined;
  }

  const toolUses = finiteNonNegativeInteger(usage.tool_uses);
  const durationMs = finiteNonNegativeInteger(usage.duration_ms);
  return {
    ...snapshot,
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.make(value);
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.make(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

/** True when the tool is a Claude Task/Agent (subagent spawn) tool. */
function isClaudeSubagentToolName(toolName: string): boolean {
  return classifyToolItemType(toolName) === "collab_agent_tool_call";
}

/**
 * Remember Task/Agent tool inputs keyed by tool_use id so later
 * `task_started` events can resolve the requested subagent model.
 */
function rememberTaskToolInput(
  context: ClaudeSessionContext,
  tool: Pick<ToolInFlight, "itemId" | "toolName" | "input">,
): void {
  if (!isClaudeSubagentToolName(tool.toolName)) {
    return;
  }
  if (!tool.itemId || tool.itemId.length === 0) {
    return;
  }
  context.taskToolInputsByUseId.set(tool.itemId, tool.input);
}

function rememberTaskToolUseId(
  context: ClaudeSessionContext,
  taskId: string,
  toolUseId: string | undefined,
): void {
  if (!toolUseId) {
    return;
  }
  context.taskToolUseIdByTaskId.set(taskId, toolUseId);
}

/** Drop remembered Task tool input once the correlated subagent is terminal. */
function forgetTaskToolInputForTask(
  context: ClaudeSessionContext,
  taskId: string,
  toolUseIdFromMessage?: string,
): void {
  const toolUseId = toolUseIdFromMessage ?? context.taskToolUseIdByTaskId.get(taskId);
  context.taskToolUseIdByTaskId.delete(taskId);
  context.taskModelByTaskId.delete(taskId);
  if (toolUseId) {
    context.taskToolInputsByUseId.delete(toolUseId);
  }
}

function clearTaskToolInputMemory(context: ClaudeSessionContext): void {
  context.taskToolInputsByUseId.clear();
  context.taskToolUseIdByTaskId.clear();
  context.taskModelByTaskId.clear();
}

/**
 * Drop Task tool / model correlation memory for tasks that are no longer open.
 * Open tasks keep their mappings so background subagent assistant messages
 * arriving after the parent turn ends can still resolve parent_tool_use_id
 * and avoid re-emitting an already-mined model. Orphan tool_use inputs that
 * never started a task are dropped so the maps cannot grow across turns.
 */
function pruneTaskToolInputMemoryForClosedTasks(context: ClaudeSessionContext): void {
  for (const taskId of [...context.taskToolUseIdByTaskId.keys()]) {
    if (!context.openTaskIds.has(taskId)) {
      forgetTaskToolInputForTask(context, taskId);
    }
  }
  for (const taskId of [...context.taskModelByTaskId.keys()]) {
    if (!context.openTaskIds.has(taskId)) {
      context.taskModelByTaskId.delete(taskId);
    }
  }
  const liveToolUseIds = new Set(context.taskToolUseIdByTaskId.values());
  for (const toolUseId of [...context.taskToolInputsByUseId.keys()]) {
    if (!liveToolUseIds.has(toolUseId)) {
      context.taskToolInputsByUseId.delete(toolUseId);
    }
  }
}

function readOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the model for a subagent task from authoritative per-task sources
 * only. Today that is the Task tool input's `model` override (looked up via
 * tool_use_id). Do not fall back to the parent session model — that fabricates
 * a badge value when the subagent actually ran something else. Returns
 * undefined when nothing authoritative is known yet; ground truth may arrive
 * later from subagent assistant messages.
 */
function resolveSubagentTaskModel(
  context: ClaudeSessionContext,
  toolUseId: string | undefined,
): string | undefined {
  if (!toolUseId) {
    return undefined;
  }
  const input = context.taskToolInputsByUseId.get(toolUseId);
  return readOptionalTrimmedString(input?.model);
}

function findTaskIdForToolUseId(
  context: ClaudeSessionContext,
  toolUseId: string,
): string | undefined {
  for (const [taskId, mappedToolUseId] of context.taskToolUseIdByTaskId) {
    if (mappedToolUseId === toolUseId) {
      return taskId;
    }
  }
  return undefined;
}

/** Record a task model; returns true when the stored value changed. */
function rememberTaskModel(context: ClaudeSessionContext, taskId: string, model: string): boolean {
  if (context.taskModelByTaskId.get(taskId) === model) {
    return false;
  }
  context.taskModelByTaskId.set(taskId, model);
  return true;
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}

type PlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

function extractPlanStepsFromTodoInput(input: Record<string, unknown>): PlanStep[] | null {
  // TodoWrite format: { todos: [{ content, status, activeForm? }] }
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) {
    return null;
  }
  return todos
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((todo) => ({
      step:
        typeof todo.content === "string" && todo.content.trim().length > 0
          ? todo.content.trim()
          : "Task",
      status:
        todo.status === "completed"
          ? "completed"
          : todo.status === "in_progress"
            ? "inProgress"
            : "pending",
    }));
}

type ClaudeTaskToolKind = "create" | "get" | "update" | "list";

function claudeTaskToolKind(toolName: string): ClaudeTaskToolKind | undefined {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  switch (normalized) {
    case "taskcreate":
      return "create";
    case "taskget":
      return "get";
    case "taskupdate":
      return "update";
    case "tasklist":
      return "list";
    default:
      return undefined;
  }
}

function normalizeClaudeTaskStatus(value: unknown): PlanStep["status"] {
  if (typeof value !== "string") {
    return "pending";
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "completed":
    case "complete":
    case "done":
    case "success":
    case "succeeded":
    case "passed":
    case "failed":
    case "failure":
    case "error":
    case "errored":
    case "killed":
    case "stopped":
    case "cancelled":
    case "canceled":
      return "completed";
    case "in_progress":
    case "inprogress":
    case "running":
    case "active":
    case "started":
    case "executing":
      return "inProgress";
    case "pending":
    case "queued":
    case "todo":
    case "not_started":
    case "paused":
    case "blocked":
    default:
      return "pending";
  }
}

function isDeletedClaudeTaskStatus(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized === "deleted" || normalized === "delete" || normalized === "removed";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): Array<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readJsonRecordFromToolResultBlock(
  block: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const content = block.content;
  const directContent = asRecord(content);
  if (directContent) {
    return directContent;
  }

  const text = extractTextContent(content).trim();
  return text.length > 0 ? tryParseJsonRecord(text) : undefined;
}

function readClaudeToolUseResult(
  message: SDKMessage,
  block?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (message.type !== "user") {
    return undefined;
  }
  return (
    asRecord((message as { readonly tool_use_result?: unknown }).tool_use_result) ??
    (block ? readJsonRecordFromToolResultBlock(block) : undefined)
  );
}

function readClaudeTaskFromResult(
  result: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asRecord(result?.task) ?? asRecord(result);
}

function readClaudeTaskSubject(input: Record<string, unknown>): string | undefined {
  return readString(input.subject) ?? readString(input.description) ?? readString(input.activeForm);
}

function readClaudeTaskId(input: Record<string, unknown>): string | undefined {
  return readString(input.taskId) ?? readString(input.task_id) ?? readString(input.id);
}

function syntheticClaudeTaskId(tool: ToolInFlight): string {
  return `tool:${tool.itemId}`;
}

function updateClaudeTaskBlockedBy(
  task: ClaudeTaskState,
  input: {
    readonly add?: ReadonlyArray<string>;
    readonly remove?: ReadonlyArray<string>;
    readonly replace?: ReadonlyArray<string>;
  },
): boolean {
  let changed = false;
  if (input.replace) {
    const next = new Set(input.replace);
    const current = Array.from(task.blockedBy);
    if (current.length !== next.size || current.some((entry) => !next.has(entry))) {
      task.blockedBy.clear();
      for (const dependency of next) {
        task.blockedBy.add(dependency);
      }
      changed = true;
    }
  }
  for (const dependency of input.add ?? []) {
    if (!task.blockedBy.has(dependency)) {
      task.blockedBy.add(dependency);
      changed = true;
    }
  }
  for (const dependency of input.remove ?? []) {
    if (task.blockedBy.delete(dependency)) {
      changed = true;
    }
  }
  return changed;
}

function upsertClaudeTask(
  tasks: Map<string, ClaudeTaskState>,
  input: {
    readonly id: string;
    readonly subject?: string;
    readonly status?: PlanStep["status"];
    readonly blockedBy?: ReadonlyArray<string>;
  },
): boolean {
  const subject = input.subject ?? "Task";
  const status = input.status ?? "pending";
  const existing = tasks.get(input.id);
  if (!existing) {
    tasks.set(input.id, {
      id: input.id,
      subject,
      status,
      blockedBy: new Set(input.blockedBy ?? []),
    });
    return true;
  }

  let changed = false;
  if (input.subject && existing.subject !== input.subject) {
    existing.subject = input.subject;
    changed = true;
  }
  if (input.status && existing.status !== input.status) {
    existing.status = input.status;
    changed = true;
  }
  if (
    input.blockedBy &&
    updateClaudeTaskBlockedBy(existing, {
      replace: input.blockedBy,
    })
  ) {
    changed = true;
  }
  return changed;
}

function replaceClaudeTaskId(
  tasks: Map<string, ClaudeTaskState>,
  fromId: string,
  toId: string,
): boolean {
  if (fromId === toId || !tasks.has(fromId)) {
    return false;
  }

  const entries = Array.from(tasks.entries());
  const existingTarget = tasks.get(toId);
  tasks.clear();
  let changed = false;
  for (const [id, task] of entries) {
    if (id === fromId) {
      if (existingTarget) {
        tasks.set(toId, {
          id: toId,
          subject: existingTarget.subject || task.subject,
          status: existingTarget.status,
          blockedBy: new Set([...task.blockedBy, ...existingTarget.blockedBy]),
        });
      } else {
        tasks.set(toId, {
          id: toId,
          subject: task.subject,
          status: task.status,
          blockedBy: new Set(task.blockedBy),
        });
      }
      changed = true;
      continue;
    }
    if (id === toId && existingTarget) {
      continue;
    }
    tasks.set(id, task);
  }

  for (const task of tasks.values()) {
    if (task.blockedBy.delete(fromId)) {
      task.blockedBy.add(toId);
      changed = true;
    }
  }
  return changed;
}

function applyClaudeTaskToolInput(
  tasks: Map<string, ClaudeTaskState>,
  tool: ToolInFlight,
): boolean {
  const kind = claudeTaskToolKind(tool.toolName);
  if (!kind) {
    return false;
  }

  if (kind === "create") {
    const subject = readClaudeTaskSubject(tool.input);
    if (!subject) {
      return false;
    }
    return upsertClaudeTask(tasks, {
      id: syntheticClaudeTaskId(tool),
      subject,
      status: normalizeClaudeTaskStatus(tool.input.status),
      blockedBy: [
        ...readStringArray(tool.input.blockedBy),
        ...readStringArray(tool.input.addBlockedBy),
      ],
    });
  }

  if (kind !== "update") {
    return false;
  }

  const taskId = readClaudeTaskId(tool.input);
  if (!taskId) {
    return false;
  }
  if (isDeletedClaudeTaskStatus(tool.input.status)) {
    return tasks.delete(taskId);
  }

  const subject = readClaudeTaskSubject(tool.input);
  const hasStatus = typeof tool.input.status === "string";
  const existing = tasks.get(taskId);
  let changed = false;
  if (!existing) {
    tasks.set(taskId, {
      id: taskId,
      subject: subject ?? "Task",
      status: hasStatus ? normalizeClaudeTaskStatus(tool.input.status) : "pending",
      blockedBy: new Set([
        ...readStringArray(tool.input.blockedBy),
        ...readStringArray(tool.input.addBlockedBy),
      ]),
    });
    changed = true;
  } else {
    if (subject && existing.subject !== subject) {
      existing.subject = subject;
      changed = true;
    }
    if (hasStatus) {
      const status = normalizeClaudeTaskStatus(tool.input.status);
      if (existing.status !== status) {
        existing.status = status;
        changed = true;
      }
    }
  }

  const task = tasks.get(taskId);
  if (
    task &&
    updateClaudeTaskBlockedBy(task, {
      add: [...readStringArray(tool.input.blockedBy), ...readStringArray(tool.input.addBlockedBy)],
      remove: readStringArray(tool.input.removeBlockedBy),
    })
  ) {
    changed = true;
  }
  return changed;
}

function applyClaudeTaskToolResult(
  tasks: Map<string, ClaudeTaskState>,
  tool: ToolInFlight,
  result: Record<string, unknown> | undefined,
): boolean {
  const kind = claudeTaskToolKind(tool.toolName);
  if (!kind) {
    return false;
  }

  if (kind === "list") {
    const resultTasks = result?.tasks;
    if (!Array.isArray(resultTasks)) {
      return false;
    }
    tasks.clear();
    for (const entry of resultTasks) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const task = entry as Record<string, unknown>;
      const id = readString(task.id);
      const subject = readString(task.subject);
      if (!id || !subject) {
        continue;
      }
      tasks.set(id, {
        id,
        subject,
        status: normalizeClaudeTaskStatus(task.status),
        blockedBy: new Set(readStringArray(task.blockedBy)),
      });
    }
    return true;
  }

  if (kind === "get") {
    const inputTaskId = readClaudeTaskId(tool.input);
    if (result && "task" in result && result.task === null) {
      return inputTaskId ? tasks.delete(inputTaskId) : false;
    }
    const resultTask = readClaudeTaskFromResult(result);
    if (!resultTask) {
      return inputTaskId ? tasks.delete(inputTaskId) : false;
    }
    const id = readClaudeTaskId(resultTask) ?? inputTaskId;
    const subject = readClaudeTaskSubject(resultTask);
    if (!id || !subject) {
      return false;
    }
    return upsertClaudeTask(tasks, {
      id,
      subject,
      status: normalizeClaudeTaskStatus(resultTask.status),
      ...(resultTask.blockedBy !== undefined
        ? { blockedBy: readStringArray(resultTask.blockedBy) }
        : {}),
    });
  }

  if (kind === "create") {
    const resultTask = readClaudeTaskFromResult(result);
    const syntheticId = syntheticClaudeTaskId(tool);
    const resultId =
      readClaudeTaskId(resultTask ?? {}) ?? readClaudeTaskId(result ?? {}) ?? syntheticId;
    const subject =
      readClaudeTaskSubject(tool.input) ??
      (resultTask ? readClaudeTaskSubject(resultTask) : undefined) ??
      (result ? readClaudeTaskSubject(result) : undefined);
    let changed = replaceClaudeTaskId(tasks, syntheticId, resultId);
    if (
      upsertClaudeTask(tasks, {
        id: resultId,
        ...(subject ? { subject } : {}),
        status: normalizeClaudeTaskStatus(tool.input.status),
        blockedBy: [
          ...readStringArray(tool.input.blockedBy),
          ...readStringArray(tool.input.addBlockedBy),
        ],
      })
    ) {
      changed = true;
    }
    return changed;
  }

  const taskId = readClaudeTaskId(tool.input) ?? readClaudeTaskId(result ?? {});
  if (!taskId) {
    return false;
  }
  if (isDeletedClaudeTaskStatus(tool.input.status)) {
    return tasks.delete(taskId);
  }

  const statusChange = asRecord(result?.statusChange);
  const resultStatus = result?.status ?? statusChange?.to;
  const subject =
    readClaudeTaskSubject(tool.input) ?? (result ? readClaudeTaskSubject(result) : undefined);
  const status =
    typeof tool.input.status === "string"
      ? normalizeClaudeTaskStatus(tool.input.status)
      : typeof resultStatus === "string"
        ? normalizeClaudeTaskStatus(resultStatus)
        : undefined;
  let changed = upsertClaudeTask(tasks, {
    id: taskId,
    ...(subject ? { subject } : {}),
    ...(status ? { status } : {}),
    ...(tool.input.blockedBy !== undefined
      ? { blockedBy: readStringArray(tool.input.blockedBy) }
      : {}),
  });

  const task = tasks.get(taskId);
  if (
    task &&
    updateClaudeTaskBlockedBy(task, {
      add: readStringArray(tool.input.addBlockedBy),
      remove: readStringArray(tool.input.removeBlockedBy),
    })
  ) {
    changed = true;
  }
  return changed;
}

function planStepsFromClaudeTasks(tasks: Map<string, ClaudeTaskState>): PlanStep[] {
  return Array.from(tasks.values()).map((task) => {
    const blockedBy = Array.from(task.blockedBy);
    const blockedSuffix = blockedBy.length > 0 ? ` (blocked by #${blockedBy.join(", #")})` : "";
    return {
      step: `${task.subject}${blockedSuffix}`,
      status: task.status,
    };
  });
}

function claudeTaskPlanFingerprint(plan: ReadonlyArray<PlanStep>): string {
  return JSON.stringify(plan);
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  // For agent/subagent tools, prefer human-readable description or prompt over raw JSON
  const itemType = classifyToolItemType(toolName);
  if (itemType === "collab_agent_tool_call") {
    const description =
      typeof input.description === "string" ? input.description.trim() : undefined;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : undefined;
    const subagentType =
      typeof input.subagent_type === "string" ? input.subagent_type.trim() : undefined;
    const label = description || (prompt ? prompt.slice(0, 200) : undefined);
    if (label) {
      return subagentType ? `${subagentType}: ${label}` : label;
    }
  }

  const serialized = encodeJsonStringForDiagnostics(input) ?? "[unserializable input]";
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

const RESUME_DEAD_SHELL_NOTE =
  "[Note: this session was resumed after a restart. Any background shells or background tasks from before the restart are dead — do not poll or wait on them; restart that work if still needed.]";

function buildPromptText(
  input: ProviderSendTurnInput,
  boundInstanceId: ProviderInstanceId,
  options?: {
    readonly appendResumeDeadShellNote?: boolean;
    readonly getModelCapabilities?: ClaudeModelCapabilitiesLookup | undefined;
  },
): string {
  const rawEffort =
    input.modelSelection?.instanceId === boundInstanceId
      ? getModelSelectionStringOptionValue(input.modelSelection, "effort")
      : null;
  const claudeModel =
    input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection.model : undefined;
  const caps =
    options?.getModelCapabilities?.(claudeModel) ?? getClaudeModelCapabilities(claudeModel);

  const promptEffort = resolvePromptInjectedEffort(caps, rawEffort);
  const base = applyClaudePromptEffortPrefix(input.input?.trim() ?? "", promptEffort);
  if (!options?.appendResumeDeadShellNote) {
    return base;
  }
  if (base.length === 0) {
    return RESUME_DEAD_SHELL_NOTE;
  }
  return `${base}\n\n${RESUME_DEAD_SHELL_NOTE}`;
}

function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

/**
 * Build a Claude SDK user message from canonical send-turn input.
 *
 * The provider dependency is threaded in so validation/read failures are
 * stamped with the active Claude-backed driver (`claudeAgent`,
 * `claude-synthero`, etc.) instead of always reporting the stock Claude
 * provider.
 *
 * @param input - Canonical send-turn payload from the provider service.
 * @param dependencies - File, attachment, instance, and provider context.
 * @returns A Claude SDK user message containing text and supported images.
 */
const buildUserMessageEffect = Effect.fn("buildUserMessageEffect")(function* (
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
    readonly boundInstanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
    readonly appendResumeDeadShellNote?: boolean;
    readonly getModelCapabilities?: ClaudeModelCapabilitiesLookup | undefined;
  },
) {
  const text = buildPromptText(input, dependencies.boundInstanceId, {
    appendResumeDeadShellNote: dependencies.appendResumeDeadShellNote === true,
    getModelCapabilities: dependencies.getModelCapabilities,
  });
  const sdkContent: Array<Record<string, unknown>> = [];

  if (text.length > 0) {
    sdkContent.push({ type: "text", text });
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return yield* new ProviderAdapterRequestError({
        provider: dependencies.provider,
        method: "turn/start",
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
      });
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: dependencies.provider,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: dependencies.provider,
            method: "turn/start",
            detail: "Failed to read attachment file.",
            cause,
          }),
      ),
    );

    sdkContent.push(
      buildClaudeImageContentBlock({
        mimeType: attachment.mimeType,
        bytes,
      }),
    );
  }

  return buildUserMessage({ sdkContent });
});

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.make(options.providerItemId),
    };
  }
  return {};
}

function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  const result = decodeUnknownJsonStringExit(value);
  if (!Exit.isSuccess(result)) {
    return undefined;
  }
  const parsed = result.value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  return encodeJsonStringForDiagnostics(input);
}

function toolResultStreamKind(itemType: CanonicalItemType): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

/**
 * Convert SDK/session failures that imply a missing or closed session into
 * typed provider-adapter session errors for the active Claude-backed driver.
 *
 * @param provider - Driver kind to stamp onto the returned error.
 * @param threadId - Thread whose session operation failed.
 * @param cause - Unknown SDK/runtime failure cause.
 * @returns A typed session error when recognized, otherwise `undefined`.
 */
function toSessionError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause,
    });
  }
  return undefined;
}

/**
 * Convert an unknown Claude SDK failure into a typed provider adapter error.
 *
 * Session-not-found/closed causes are preserved as session errors; all other
 * failures become request errors stamped with the active Claude-backed driver.
 *
 * @param provider - Driver kind to stamp onto the error.
 * @param threadId - Thread whose request failed.
 * @param method - Logical adapter method/operation name.
 * @param cause - Unknown SDK/runtime failure cause.
 * @returns A typed provider adapter error.
 */
function toRequestError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(provider, threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: `${method} failed`,
    cause,
  });
}

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

// Discriminator/identity keys carry no human-readable content; everything else
// on an unmodeled SDK message is potentially worth surfacing in the work log.
const SDK_MESSAGE_NOISE_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "parent_uuid",
  "session_id",
  "parent_tool_use_id",
  "request_id",
]);

// Pull the salient scalar content out of a message the adapter doesn't model
// yet, so the work-log row shows what actually arrived (e.g. a notification's
// text) instead of an opaque "unhandled subtype" placeholder. Nested structures
// are left to the full payload retained in the event's `detail`.
function previewUnknownSdkContent(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
    if (SDK_MESSAGE_NOISE_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        parts.push(`${key}: ${trimmed}`);
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join(" · ");
  return joined.length > 280 ? `${joined.slice(0, 279)}…` : joined;
}

function describeUnknownSdkMessage(kind: string, message: unknown): string {
  const preview = previewUnknownSdkContent(message);
  return preview ? `${kind} — ${preview}` : `${kind} (no displayable text content)`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

/**
 * Construct a scoped Claude adapter instance.
 *
 * The optional `driverKind` lets first-class Claude-backed providers reuse
 * the adapter while stamping sessions, events, logs, and errors with their
 * own provider kind.
 *
 * @param claudeSettings - Effective Claude runtime settings for this instance.
 * @param options - Instance id, driver identity, environment, query factory,
 * and native event logging overrides.
 * @returns A provider adapter backed by the Claude Agent SDK.
 */
export const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  claudeSettings: ClaudeSettings,
  options?: ClaudeAdapterLiveOptions,
) {
  const PROVIDER = options?.driverKind ?? DEFAULT_CLAUDE_PROVIDER;
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("claudeAgent");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, options?.environment).pipe(
    Effect.provideService(Path.Path, path),
  );
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) =>
      query({
        prompt: input.prompt,
        options: input.options,
      }) as ClaudeQueryRuntime);

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Claude runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const logNativeSdkMessage = Effect.fn("logNativeSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    const observedAt = yield* nowIso;
    const itemId = sdkNativeItemId(message);

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : yield* randomUUIDv4,
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          ...(itemId ? { itemId: ProviderItemId.make(itemId) } : {}),
          payload: message,
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return {
      threadId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    };
  });

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    const threadId = context.session.threadId;
    if (!threadId) return;

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.turns.length,
    };

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    };
  });

  const ensureAssistantTextBlock = Effect.fn("ensureAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex);
    if (existing && !existing.completionEmitted) {
      if (existing.fallbackText.length === 0 && options?.fallbackText) {
        existing.fallbackText = options.fallbackText;
      }
      if (options?.streamClosed) {
        existing.streamClosed = true;
      }
      return { blockIndex, block: existing };
    }

    const block: AssistantTextBlockState = {
      itemId: yield* randomUUIDv4,
      blockIndex,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
    return { blockIndex, block };
  });

  const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
    function* (context: ClaudeSessionContext, fallbackText: string) {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    },
  );

  const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || block.completionEmitted) {
      return;
    }

    if (!options?.force && !block.streamClosed) {
      return;
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0) {
      const deltaStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "content.delta",
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: "assistant_text",
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    }

    block.completionEmitted = true;
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
      turnState.assistantTextBlocks.delete(block.blockIndex);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    });
  });

  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    "backfillAssistantTextBlocksFromSnapshot",
  )(function* (context: ClaudeSessionContext, message: SDKMessage) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    const snapshotTextBlocks = extractAssistantTextBlocks(message);
    if (snapshotTextBlocks.length === 0) {
      return;
    }

    const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
      blockIndex: block.blockIndex,
      block,
    }));

    for (const [position, text] of snapshotTextBlocks.entries()) {
      const existingEntry = orderedBlocks[position];
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) => {
            if (!created) {
              return undefined;
            }
            orderedBlocks.push(created);
            return created;
          }),
        ));
      if (!entry) {
        continue;
      }

      if (entry.block.fallbackText.length === 0) {
        entry.block.fallbackText = text;
      }

      if (entry.block.streamClosed && !entry.block.completionEmitted) {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }
  });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (typeof message.session_id !== "string" || message.session_id.length === 0) {
      return;
    }
    if (!hasDurableClaudeSessionId(message)) {
      return;
    }
    const nextThreadId = message.session_id;
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) {
      void cause;
    }
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: isUsageLimitDetail(cause) ? "usage_limit" : "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitThreadTokenUsage = Effect.fn("emitThreadTokenUsage")(function* (
    context: ClaudeSessionContext,
    usage: ThreadTokenUsageSnapshot | undefined,
    options?: {
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    if (!usage) {
      return;
    }

    context.lastKnownTokenUsage = usage;
    context.lastKnownTotalProcessedTokens =
      usage.totalProcessedTokens ?? context.lastKnownTotalProcessedTokens;

    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: turnState.turnId } : {}),
      payload: {
        usage,
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options.rawPayload,
            },
          }
        : {}),
    });
  });

  const queryCurrentContextUsage = Effect.fn("queryCurrentContextUsage")(function* (
    context: ClaudeSessionContext,
    totalProcessedTokens?: number,
  ) {
    if (!context.query.getContextUsage) {
      return undefined;
    }

    const usage = yield* Effect.promise(async () => {
      try {
        return await context.query.getContextUsage?.();
      } catch {
        return undefined;
      }
    });
    if (!usage) {
      return undefined;
    }

    context.lastKnownContextWindow = usage.maxTokens;
    return normalizeClaudeContextUsageApiSnapshot(usage, totalProcessedTokens);
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const emitClaudeTaskPlanUpdated = Effect.fn("emitClaudeTaskPlanUpdated")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly toolUseId: string;
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const plan = planStepsFromClaudeTasks(context.claudeTasks);
    const fingerprint = claudeTaskPlanFingerprint(plan);
    if (context.claudeTaskPlanFingerprint === fingerprint) {
      return;
    }
    context.claudeTaskPlanFingerprint = fingerprint;

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.plan.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        explanation: "Claude Tasks",
        plan,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: "claude.sdk.message",
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  /**
   * Emit synthetic `task.completed` (status "stopped") for every still-open
   * subagent task so the projection/UI stop treating them as running.
   */
  const closeOpenSubagentTasks = Effect.fn("closeOpenSubagentTasks")(function* (
    context: ClaudeSessionContext,
    summary: string,
  ) {
    if (context.openTaskIds.size === 0) {
      return;
    }
    const openIds = Array.from(context.openTaskIds);
    context.openTaskIds.clear();
    for (const taskId of openIds) {
      context.syntheticallyStoppedTaskIds.add(taskId);
      forgetTaskToolInputForTask(context, taskId);
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "task.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        payload: {
          taskId: RuntimeTaskId.make(taskId),
          status: "stopped",
          summary,
        },
        providerRefs: nativeProviderRefs(context),
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic/task_stopped",
          payload: { taskId, reason: summary },
        },
      });
    }
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) {
    if (status === "interrupted" || status === "cancelled") {
      yield* closeOpenSubagentTasks(
        context,
        status === "cancelled"
          ? "Task stopped (turn cancelled)."
          : "Task stopped (turn interrupted).",
      );
    }
    // Drop closed/orphan Task tool memory so maps cannot grow across turns,
    // but keep open-task correlation so background subagent messages after
    // the parent turn ends can still resolve parent_tool_use_id → taskId.
    pruneTaskToolInputMemoryForClosedTasks(context);

    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }

    const maxTokens = resultContextWindow ?? context.lastKnownContextWindow;
    const accumulatedTotalProcessedTokens = claudeTotalProcessedTokens(result?.usage);
    if (accumulatedTotalProcessedTokens !== undefined) {
      context.lastKnownTotalProcessedTokens = accumulatedTotalProcessedTokens;
    }

    const contextUsageSnapshot = yield* queryCurrentContextUsage(
      context,
      accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
    );
    const resultUsageRecord =
      result?.usage && typeof result.usage === "object" && !Array.isArray(result.usage)
        ? (result.usage as Record<string, unknown>)
        : undefined;
    const hasResultUsageIteration =
      resultUsageRecord !== undefined && lastClaudeUsageIteration(resultUsageRecord) !== undefined;
    const resultHasActiveUsage =
      resultUsageRecord !== undefined &&
      (hasResultUsageIteration ||
        claudeUsageInputTokens(resultUsageRecord) + claudeUsageOutputTokens(resultUsageRecord) > 0);
    const resultTotalOnly =
      resultUsageRecord !== undefined &&
      !resultHasActiveUsage &&
      claudeTotalProcessedTokens(resultUsageRecord) !== undefined;
    const resultIterationSnapshot = resultUsageRecord
      ? normalizeClaudeActiveTokenUsage(
          resultUsageRecord,
          maxTokens,
          accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
        )
      : undefined;
    const lastGoodUsage = context.lastKnownTokenUsage;
    const usageSnapshot: ThreadTokenUsageSnapshot | undefined =
      contextUsageSnapshot ??
      (resultTotalOnly && lastGoodUsage
        ? {
            ...lastGoodUsage,
            ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
              ? { maxTokens }
              : {}),
            ...(typeof accumulatedTotalProcessedTokens === "number" &&
            Number.isFinite(accumulatedTotalProcessedTokens) &&
            accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
              ? {
                  totalProcessedTokens: accumulatedTotalProcessedTokens,
                }
              : {}),
          }
        : resultIterationSnapshot) ??
      (lastGoodUsage
        ? {
            ...lastGoodUsage,
            ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
              ? { maxTokens }
              : {}),
            ...(typeof accumulatedTotalProcessedTokens === "number" &&
            Number.isFinite(accumulatedTotalProcessedTokens) &&
            accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
              ? {
                  totalProcessedTokens: accumulatedTotalProcessedTokens,
                }
              : {}),
          }
        : undefined);

    const turnState = context.turnState;
    if (!turnState) {
      yield* emitThreadTokenUsage(context, usageSnapshot, {
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          state: status,
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        providerRefs: {},
      });
      return;
    }

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    context.turns.push({
      id: turnState.turnId,
      items: [...turnState.items],
    });

    yield* emitThreadTokenUsage(context, usageSnapshot, {
      rawMethod: "claude/result",
      rawPayload: result ?? { status },
    });

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(typeof result?.total_cost_usd === "number"
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });

    const updatedAt = yield* nowIso;
    context.turnState = undefined;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
      ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
    };
    yield* updateResumeCursor(context);
  });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;

    if (event.type === "message_delta") {
      if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) {
        return;
      }

      const snapshot = normalizeClaudeActiveTokenUsage(
        event.usage,
        context.lastKnownContextWindow,
        context.lastKnownTotalProcessedTokens,
      );
      yield* emitThreadTokenUsage(context, snapshot, {
        rawMethod: "claude/stream_event/message_delta",
        rawPayload: message,
      });
      return;
    }

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        const assistantBlockEntry =
          event.delta.type === "text_delta"
            ? yield* ensureAssistantTextBlock(context, event.index)
            : context.turnState.assistantTextBlocks.get(event.index)
              ? {
                  blockIndex: event.index,
                  block: context.turnState.assistantTextBlocks.get(
                    event.index,
                  ) as AssistantTextBlockState,
                }
              : undefined;
        if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
          assistantBlockEntry.block.emittedTextDelta = true;
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? {
                itemId: asRuntimeItemId(assistantBlockEntry.block.itemId),
              }
            : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const tool = context.inFlightTools.get(event.index);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json;
        const parsedInput = tryParseJsonRecord(partialInputJson);
        const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJson,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(event.index, nextTool);

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(event.index, nextTool);
        rememberTaskToolInput(context, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: "inProgress",
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: nextTool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });

        // Emit plan update when TodoWrite input is parsed
        if (parsedInput && isTodoTool(nextTool.toolName)) {
          const planSteps = extractPlanStepsFromTodoInput(parsedInput);
          if (planSteps && planSteps.length > 0) {
            const planStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "turn.plan.updated",
              eventId: planStamp.eventId,
              provider: PROVIDER,
              createdAt: planStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState
                ? {
                    turnId: asCanonicalTurnId(context.turnState.turnId),
                  }
                : {}),
              payload: {
                plan: planSteps,
              },
              providerRefs: nativeProviderRefs(context),
            });
          }
        }
        if (parsedInput && applyClaudeTaskToolInput(context.claudeTasks, nextTool)) {
          yield* emitClaudeTaskPlanUpdated(context, {
            toolUseId: nextTool.itemId,
            rawMethod: "claude/stream_event/content_block_delta/input_json_delta",
            rawPayload: message,
          });
        }
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      if (block.type === "text") {
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }

      const toolName = block.name;
      const itemType = classifyToolItemType(toolName);
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemId = block.id;
      const detail = summarizeToolRequest(toolName, toolInput);
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        title: titleForTool(itemType),
        detail,
        input: toolInput,
        partialInputJson: "",
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
      };
      context.inFlightTools.set(index, tool);
      rememberTaskToolInput(context, tool);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: message,
        },
      });
      if (applyClaudeTaskToolInput(context.claudeTasks, tool)) {
        yield* emitClaudeTaskPlanUpdated(context, {
          toolUseId: tool.itemId,
          rawMethod: "claude/stream_event/content_block_start",
          rawPayload: message,
        });
      }
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
      if (!tool) {
        return;
      }
    }
  });

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
    }

    for (const toolResult of toolResultBlocksFromUserMessage(message)) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const toolUseResult = readClaudeToolUseResult(message, toolResult.block);
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: toolResult.block,
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: tool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      if (
        !toolResult.isError &&
        applyClaudeTaskToolResult(context.claudeTasks, tool, toolUseResult)
      ) {
        yield* emitClaudeTaskPlanUpdated(context, {
          toolUseId: tool.itemId,
          rawMethod: "claude/user",
          rawPayload: message,
        });
      }

      context.inFlightTools.delete(index);
    }
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }

    // Subagent completions carry parent_tool_use_id + the actual model that
    // produced the turn. Mine it into task.updated when it differs from what
    // we already recorded (tool-input override or a prior assistant message).
    const parentToolUseId = readOptionalTrimmedString(
      (message as { parent_tool_use_id?: unknown }).parent_tool_use_id,
    );
    if (parentToolUseId) {
      const observedModel = readOptionalTrimmedString(
        (message.message as { model?: unknown } | undefined)?.model,
      );
      if (observedModel) {
        const taskId = findTaskIdForToolUseId(context, parentToolUseId);
        if (taskId && rememberTaskModel(context, taskId, observedModel)) {
          const modelStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "task.updated",
            eventId: modelStamp.eventId,
            provider: PROVIDER,
            createdAt: modelStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.message",
              method: "claude/assistant/subagent-model",
              payload: message,
            },
            payload: {
              taskId: RuntimeTaskId.make(taskId),
              model: observedModel,
            },
          });
        }
      }
    }

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState) {
      const turnId = TurnId.make(yield* randomUUIDv4);
      const startedAt = yield* nowIso;
      context.turnState = {
        turnId,
        startedAt,
        synthetic: true,
        items: [],
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        nextSyntheticAssistantBlockIndex: -1,
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (toolUse.type === "tool_use" && typeof toolUse.name === "string") {
          const toolUseId = typeof toolUse.id === "string" ? toolUse.id : undefined;
          const toolInput =
            typeof toolUse.input === "object" && toolUse.input !== null
              ? (toolUse.input as Record<string, unknown>)
              : {};
          if (toolUseId) {
            rememberTaskToolInput(context, {
              itemId: toolUseId,
              toolName: toolUse.name,
              input: toolInput,
            });
          }
        }
        if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
      yield* backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* updateResumeCursor(context);
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") {
      return;
    }

    const status = turnStatusFromResult(message);
    const errorMessage = message.subtype === "success" ? undefined : message.errors[0];
    const usageLimit =
      status === "failed"
        ? (detectClaudeUsageLimit({
            message: errorMessage,
            raw: message,
            source: "result",
          }) ?? context.pendingUsageLimit)
        : undefined;

    if (status === "failed") {
      yield* emitRuntimeError(
        context,
        errorMessage ?? (usageLimit ? "Claude usage limit reached." : "Claude turn failed."),
        usageLimit,
      );
    }

    yield* completeTurn(context, status, errorMessage, message);
    if (usageLimit !== undefined || status !== "failed") {
      context.pendingUsageLimit = undefined;
    }
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    switch (message.subtype) {
      case "init":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });
        return;
      case "status":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        return;
      case "compact_boundary":
        yield* emitThreadTokenUsage(
          context,
          compactBoundaryTokenUsageSnapshot(
            message as unknown as Record<string, unknown>,
            context.lastKnownContextWindow,
            context.lastKnownTotalProcessedTokens,
          ),
          {
            rawMethod: "claude/system/compact_boundary",
            rawPayload: message,
          },
        );
        yield* offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });
        return;
      case "hook_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "task_started": {
        const toolUseId = readOptionalTrimmedString(
          (message as { tool_use_id?: unknown }).tool_use_id,
        );
        const subagentType = readOptionalTrimmedString(
          (message as { subagent_type?: unknown }).subagent_type,
        );
        const workflowName = readOptionalTrimmedString(
          (message as { workflow_name?: unknown }).workflow_name,
        );
        const model = resolveSubagentTaskModel(context, toolUseId);
        context.openTaskIds.add(message.task_id);
        rememberTaskToolUseId(context, message.task_id, toolUseId);
        if (model) {
          context.taskModelByTaskId.set(message.task_id, model);
        }
        yield* offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(model ? { model } : {}),
            ...(message.task_type ? { taskType: message.task_type } : {}),
            ...(subagentType ? { subagentType } : {}),
            ...(workflowName ? { workflowName } : {}),
            ...(toolUseId ? { toolUseId } : {}),
          },
        });
        return;
      }
      case "task_progress": {
        const toolUseId = readOptionalTrimmedString(
          (message as { tool_use_id?: unknown }).tool_use_id,
        );
        const subagentType = readOptionalTrimmedString(
          (message as { subagent_type?: unknown }).subagent_type,
        );
        yield* emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: "claude/system/task_progress",
            rawPayload: message,
          },
        );
        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            ...(subagentType ? { subagentType } : {}),
            ...(toolUseId ? { toolUseId } : {}),
          },
        });
        return;
      }
      case "task_updated": {
        const patch =
          (message as { patch?: Record<string, unknown> }).patch &&
          typeof (message as { patch?: unknown }).patch === "object"
            ? ((message as { patch: Record<string, unknown> }).patch ?? {})
            : {};
        const status = readOptionalTrimmedString(patch.status) as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "killed"
          | "paused"
          | undefined;
        const description = readOptionalTrimmedString(patch.description);
        const error = readOptionalTrimmedString(patch.error);
        const endTime = typeof patch.end_time === "number" ? patch.end_time : undefined;
        const totalPausedMs =
          typeof patch.total_paused_ms === "number" ? patch.total_paused_ms : undefined;
        const isBackgrounded =
          typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : undefined;
        if (isTerminalTaskUpdatedStatus(status)) {
          context.openTaskIds.delete(message.task_id);
          forgetTaskToolInputForTask(
            context,
            message.task_id,
            readOptionalTrimmedString((message as { tool_use_id?: unknown }).tool_use_id),
          );
          // Late native terminal after synthetic stop: keep bookkeeping clean
          // but do not publish a second terminal state to the UI.
          if (context.syntheticallyStoppedTaskIds.delete(message.task_id)) {
            return;
          }
        }
        yield* offerRuntimeEvent({
          ...base,
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            ...(status ? { status } : {}),
            ...(description ? { description } : {}),
            ...(error ? { error } : {}),
            ...(isBackgrounded !== undefined ? { isBackgrounded } : {}),
            ...(endTime !== undefined ? { endTime } : {}),
            ...(totalPausedMs !== undefined ? { totalPausedMs } : {}),
          },
        });
        return;
      }
      case "task_notification": {
        const outputFile = readOptionalTrimmedString(
          (message as { output_file?: unknown }).output_file,
        );
        const toolUseId = readOptionalTrimmedString(
          (message as { tool_use_id?: unknown }).tool_use_id,
        );
        context.openTaskIds.delete(message.task_id);
        forgetTaskToolInputForTask(context, message.task_id, toolUseId);
        // Late native completion after synthetic stop: drop without re-emitting.
        if (context.syntheticallyStoppedTaskIds.delete(message.task_id)) {
          return;
        }
        yield* emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: "claude/system/task_notification",
            rawPayload: message,
          },
        );
        yield* offerRuntimeEvent({
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(outputFile ? { outputFile } : {}),
          },
        });
        return;
      }
      case "files_persisted":
        yield* offerRuntimeEvent({
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      case "thinking_tokens":
        return;
      case "commands_changed":
        // Slash-command list push; nothing here consumes the command list,
        // and surfacing it as a runtime warning puts noise in the chat.
        return;
      case "permission_denied":
        yield* offerRuntimeEvent({
          ...base,
          type: "tool.denied",
          payload: {
            toolName: message.tool_name,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.decision_reason ? { reason: message.decision_reason } : {}),
            ...(message.agent_id ? { agentId: message.agent_id } : {}),
          },
        });
        return;
      case "mirror_error":
        yield* emitRuntimeError(
          context,
          `Claude workspace mirror error: ${message.error}`,
          message,
        );
        return;
      default:
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude system message '${message.subtype}'`, message),
          message,
        );
        return;
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? {
                precedingToolUseIds: message.preceding_tool_use_ids,
              }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEvent({
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      const usageLimit = detectClaudeUsageLimit({
        raw: message,
        source: "rate_limit_event",
      });
      if (usageLimit !== undefined) {
        context.pendingUsageLimit = usageLimit;
      }
      yield* offerRuntimeEvent({
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      return;
    }
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* handleResultMessage(context, message);
        return;
      case "system":
        yield* handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);
        return;
      default:
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude SDK message '${message.type}'`, message),
          message,
        );
        return;
    }
  });

  const runSdkStream = (
    context: ClaudeSessionContext,
  ): Effect.Effect<void, ProviderAdapterProcessError> =>
    Stream.fromAsyncIterable(
      context.query,
      (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: "Claude runtime stream failed.",
          cause,
        }),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) =>
        handleSdkMessage(context, message).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.session.threadId,
                detail: "Failed to process Claude runtime event.",
                cause,
              }),
          ),
        ),
      ),
    );

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, ProviderAdapterProcessError>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      if (isClaudeInterruptedCause(exit.cause)) {
        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Claude runtime interrupted.");
        }
      } else {
        const failures = exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [reason.error] : [],
        );
        const usageLimit = context.pendingUsageLimit;
        const message =
          usageLimit !== undefined
            ? "Claude usage limit reached."
            : (failures[0]?.detail ?? "Claude runtime stream failed.");
        yield* emitRuntimeError(
          context,
          message,
          usageLimit ?? {
            failureCount: failures.length,
            failureTags: failures.map((failure) => failure._tag),
          },
        );
        yield* completeTurn(context, "failed", message);
      }
    } else if (context.pendingUsageLimit !== undefined) {
      const message = "Claude usage limit reached.";
      yield* emitRuntimeError(context, message, context.pendingUsageLimit);
      if (context.turnState) {
        yield* completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;

    context.stopped = true;
    clearTaskToolInputMemory(context);
    // Session is gone; drop synthetic-stop markers so they cannot leak.
    context.syntheticallyStoppedTaskIds.clear();

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "request.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision: "cancel",
        },
        providerRefs: nativeProviderRefs(context),
      });
    }
    context.pendingApprovals.clear();

    if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Session stopped.");
    } else {
      // No active turn (e.g. background tasks after the parent turn ended).
      yield* closeOpenSubagentTasks(context, "Task stopped (session stopped).");
    }

    yield* Queue.shutdown(context.promptQueue);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;
    if (streamFiber && streamFiber.pollUnsafe() === undefined) {
      yield* Fiber.interrupt(streamFiber);
    }

    yield* Effect.try({
      try: () => context.query.close(),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: "Failed to close Claude runtime query.",
          cause,
        }),
    }).pipe(
      Effect.catch((error) =>
        emitRuntimeError(context, "Failed to close Claude runtime query.", {
          errorTag: error._tag,
          provider: error.provider,
          threadId: error.threadId,
          detail: error.detail,
        }),
      ),
    );

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: "Session stopped",
          exitKind: "graceful",
        },
        providerRefs: {},
      });
    }

    sessions.delete(context.session.threadId);
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existingContext = sessions.get(input.threadId);
      if (existingContext) {
        yield* Effect.logWarning("claude.session.replacing", {
          threadId: input.threadId,
          existingSessionStatus: existingContext.session.status,
          reason: "startSession called with existing active session",
        });
        yield* stopSessionInternal(existingContext, {
          emitExitEvent: false,
        }).pipe(
          // Replacement cleanup is best-effort: never block the new session on
          // either typed failures or unexpected defects from tearing down the old one.
          Effect.catchCause((cause) =>
            Effect.logWarning("claude.session.replace.stop-failed", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );
      }

      const startedAt = yield* nowIso;
      const resumeState = readClaudeResumeState(input.resumeCursor);
      const threadId = input.threadId;
      const existingResumeSessionId = resumeState?.resume;
      const newSessionId = existingResumeSessionId === undefined ? yield* randomUUIDv4 : undefined;
      const sessionId = existingResumeSessionId ?? newSessionId;

      const runtimeContext = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(runtimeContext);
      const runPromise = Effect.runPromiseWith(runtimeContext);

      const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
      const prompt = Stream.fromQueue(promptQueue).pipe(
        Stream.filter((item) => item.type === "message"),
        Stream.map((item) => item.message),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
        ),
        Stream.toAsyncIterable,
      );

      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
      const inFlightTools = new Map<number, ToolInFlight>();
      const claudeTasks = new Map<string, ClaudeTaskState>();

      const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

      /**
       * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
       * runtime event and waiting for the user to respond via `respondToUserInput`.
       */
      const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
        context: ClaudeSessionContext,
        toolInput: Record<string, unknown>,
        callbackOptions: {
          readonly signal: AbortSignal;
          readonly toolUseID?: string;
        },
      ) {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);

        // Parse questions from the SDK's AskUserQuestion input.
        // `id` MUST equal the full question text — Claude SDK >= 2.1.121 looks
        // up answers by question text in `mapToolResultToToolResultBlockParam`,
        // so the key the UI uses to keep its draft answer must match the SDK's
        // expected lookup key. See https://github.com/pingdotgg/t3code/issues/2388
        const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
        const questions: Array<UserInputQuestion> = rawQuestions.map(
          (q: Record<string, unknown>, idx: number) => ({
            id: typeof q.question === "string" && q.question.length > 0 ? q.question : `q-${idx}`,
            header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
            question: typeof q.question === "string" ? q.question : "",
            options: Array.isArray(q.options)
              ? q.options.map((opt: Record<string, unknown>) => ({
                  label: typeof opt.label === "string" ? opt.label : "",
                  description: typeof opt.description === "string" ? opt.description : "",
                }))
              : [],
            multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
          }),
        );

        const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
        let aborted = false;
        const pendingInput: PendingUserInput = {
          questions,
          answers: answersDeferred,
        };

        // Emit user-input.requested so the UI can present the questions.
        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: { questions },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/AskUserQuestion",
            payload: {
              toolName: "AskUserQuestion",
              input: toolInput,
            },
          },
        });

        pendingUserInputs.set(requestId, pendingInput);

        // Handle abort (e.g. turn interrupted while waiting for user input).
        const onAbort = () => {
          if (!pendingUserInputs.has(requestId)) {
            return;
          }
          aborted = true;
          pendingUserInputs.delete(requestId);
          runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
        };
        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        // Block until the user provides answers.
        const answers = yield* Deferred.await(answersDeferred);
        pendingUserInputs.delete(requestId);

        // Emit user-input.resolved so the UI knows the interaction completed.
        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: { answers },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/AskUserQuestion/resolved",
            payload: { answers },
          },
        });

        if (aborted) {
          return {
            behavior: "deny",
            message: "User cancelled tool execution.",
          } satisfies PermissionResult;
        }

        // Return the answers to the SDK in the expected format:
        // { questions: [...], answers: { questionText: selectedLabel } }
        return {
          behavior: "allow",
          updatedInput: {
            questions: toolInput.questions,
            answers,
          },
        } satisfies PermissionResult;
      });

      const canUseToolEffect = Effect.fn("canUseTool")(function* (
        toolName: Parameters<CanUseTool>[0],
        toolInput: Parameters<CanUseTool>[1],
        callbackOptions: Parameters<CanUseTool>[2],
      ) {
        const context = yield* Ref.get(contextRef);
        if (!context) {
          return {
            behavior: "deny",
            message: "Claude session context is unavailable.",
          } satisfies PermissionResult;
        }

        // Handle AskUserQuestion: surface clarifying questions to the
        // user via the user-input runtime event channel, regardless of
        // runtime mode (plan mode relies on this heavily).
        if (toolName === "AskUserQuestion") {
          return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
        }

        if (toolName === "ExitPlanMode") {
          const planMarkdown = extractExitPlanModePlan(toolInput);
          if (planMarkdown) {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: callbackOptions.toolUseID,
              rawSource: "claude.sdk.permission",
              rawMethod: "canUseTool/ExitPlanMode",
              rawPayload: {
                toolName,
                input: toolInput,
              },
            });
          }

          return {
            behavior: "deny",
            message:
              "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          } satisfies PermissionResult;
        }

        const runtimeMode = input.runtimeMode ?? "full-access";
        if (runtimeMode === "full-access") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
          } satisfies PermissionResult;
        }

        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const requestType = classifyRequestType(toolName);
        const detail = summarizeToolRequest(toolName, toolInput);
        const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
        const pendingApproval: PendingApproval = {
          requestType,
          detail,
          decision: decisionDeferred,
          ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
        };

        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.opened",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            detail,
            args: {
              toolName,
              input: toolInput,
              ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/request",
            payload: {
              toolName,
              input: toolInput,
            },
          },
        });

        pendingApprovals.set(requestId, pendingApproval);

        const onAbort = () => {
          if (!pendingApprovals.has(requestId)) {
            return;
          }
          pendingApprovals.delete(requestId);
          runFork(Deferred.succeed(decisionDeferred, "cancel"));
        };

        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        const decision = yield* Deferred.await(decisionDeferred);
        pendingApprovals.delete(requestId);

        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            decision,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/decision",
            payload: {
              decision,
            },
          },
        });

        if (decision === "accept" || decision === "acceptForSession") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            ...(decision === "acceptForSession" && pendingApproval.suggestions
              ? {
                  updatedPermissions: [...pendingApproval.suggestions],
                }
              : {}),
          } satisfies PermissionResult;
        }

        return {
          behavior: "deny",
          message:
            decision === "cancel"
              ? "User cancelled tool execution."
              : "User declined tool execution.",
        } satisfies PermissionResult;
      });

      const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
        runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

      const claudeBinaryPath = claudeSettings.binaryPath;
      const extraArgs = parseCliArgs(claudeSettings.launchArgs).flags;
      const modelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const caps =
        options?.getModelCapabilities?.(modelSelection?.model) ??
        getClaudeModelCapabilities(modelSelection?.model);
      const descriptors = getProviderOptionDescriptors({ caps });
      const apiModelId = modelSelection ? resolveClaudeApiModelId(modelSelection) : undefined;
      const initialContextWindow = selectedClaudeContextWindow(
        modelSelection,
        options?.getModelCapabilities,
      );
      const rawEffort = getModelSelectionStringOptionValue(modelSelection, "effort");
      const effort = resolveClaudeEffort(caps, rawEffort) ?? null;
      const fastModeSupported = descriptors.some(
        (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
      );
      const thinkingSupported = descriptors.some(
        (descriptor) => descriptor.type === "boolean" && descriptor.id === "thinking",
      );
      const fastMode =
        getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true &&
        fastModeSupported;
      const thinking = thinkingSupported
        ? getModelSelectionBooleanOptionValue(modelSelection, "thinking")
        : undefined;
      const ultracode = isClaudeUltracodeEffort(effort);
      const effectiveEffort = getEffectiveClaudeAgentEffort(
        effort,
        modelSelection?.model,
        options?.normalizeEffort,
      );
      const runtimeModeToPermission: Record<string, PermissionMode> = {
        "auto-accept-edits": "acceptEdits",
        "full-access": "bypassPermissions",
      };
      const permissionMode = runtimeModeToPermission[input.runtimeMode];
      const settings = {
        ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
        ...(fastMode ? { fastMode: true } : {}),
        ...(ultracode ? { ultracode: true } : {}),
      };
      const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      const queryOptions: ClaudeQueryOptions = {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(apiModelId ? { model: apiModelId } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: [...CLAUDE_SETTING_SOURCES],
        // `ultracode` is a Claude Code setting, not an API effort level. It is
        // normalized to `xhigh` above and paired with `settings.ultracode`.
        ...(effectiveEffort
          ? {
              effort: effectiveEffort as unknown as NonNullable<ClaudeQueryOptions["effort"]>,
            }
          : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
        ...(newSessionId ? { sessionId: newSessionId } : {}),
        includePartialMessages: true,
        canUseTool,
        env: claudeEnvironment,
        ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
        ...(mcpSession
          ? {
              mcpServers: {
                "t3-code": {
                  type: "http",
                  url: mcpSession.endpoint,
                  headers: {
                    Authorization: mcpSession.authorizationHeader,
                  },
                },
              },
            }
          : {}),
      };

      yield* Effect.annotateCurrentSpan({
        "provider.kind": PROVIDER,
        "provider.thread_id": threadId,
        "provider.runtime_mode": input.runtimeMode,
        "claude.resume.source":
          existingResumeSessionId !== undefined ? "resume-session" : "generated-session",
        "claude.resume.thread_id": resumeState?.threadId ?? "",
        "claude.resume.session_id": existingResumeSessionId ?? "",
        "claude.resume.session_at": resumeState?.resumeSessionAt ?? "",
        "claude.resume.turn_count": resumeState?.turnCount ?? -1,
        "claude.query.cwd": input.cwd ?? "",
        "claude.query.model": apiModelId ?? "",
        "claude.query.effort": effectiveEffort ?? "",
        "claude.query.permission_mode": permissionMode ?? "",
        "claude.query.allow_dangerously_skip_permissions": permissionMode === "bypassPermissions",
        "claude.query.resume": existingResumeSessionId ?? "",
        "claude.query.session_id": newSessionId ?? "",
        "claude.query.include_partial_messages": true,
        "claude.query.additional_directories": input.cwd ? [input.cwd] : [],
        "claude.query.setting_sources": [...CLAUDE_SETTING_SOURCES],
        "claude.query.settings_json": encodeJsonStringForDiagnostics(settings) ?? "",
        "claude.query.extra_args_json": encodeJsonStringForDiagnostics(extraArgs) ?? "",
        "claude.query.path_to_executable": claudeBinaryPath,
      });

      const queryRuntime = yield* Effect.try({
        try: () =>
          createQuery({
            prompt,
            options: queryOptions,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "Failed to start Claude runtime session.",
            cause,
          }),
      });

      const session: ProviderSession = {
        threadId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(threadId ? { threadId } : {}),
        resumeCursor: {
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          turnCount: resumeState?.turnCount ?? 0,
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: ClaudeSessionContext = {
        session,
        promptQueue,
        query: queryRuntime,
        streamFiber: undefined,
        startedAt,
        basePermissionMode: permissionMode,
        currentApiModelId: apiModelId,
        resumeSessionId: sessionId,
        // Only when the SDK query was actually started with resume:.
        pendingResumeDeadShellNote: existingResumeSessionId !== undefined,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        inFlightTools,
        taskToolInputsByUseId: new Map(),
        taskToolUseIdByTaskId: new Map(),
        taskModelByTaskId: new Map(),
        openTaskIds: new Set(),
        syntheticallyStoppedTaskIds: new Set(),
        claudeTasks,
        claudeTaskPlanFingerprint: undefined,
        turnState: undefined,
        lastKnownContextWindow: initialContextWindow,
        lastKnownTokenUsage: undefined,
        lastKnownTotalProcessedTokens: undefined,
        lastAssistantUuid: resumeState?.resumeSessionAt,
        lastThreadStartedId: undefined,
        pendingUsageLimit: undefined,
        stopped: false,
      };
      yield* Ref.set(contextRef, context);
      sessions.set(threadId, context);

      const sessionStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        providerRefs: {},
      });

      const configuredStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.configured",
        eventId: configuredStamp.eventId,
        provider: PROVIDER,
        createdAt: configuredStamp.createdAt,
        threadId,
        payload: {
          config: {
            ...(apiModelId ? { model: apiModelId } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(effectiveEffort ? { effort: effectiveEffort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(fastMode ? { fastMode: true } : {}),
          },
        },
        providerRefs: {},
      });

      const readyStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        eventId: readyStamp.eventId,
        provider: PROVIDER,
        createdAt: readyStamp.createdAt,
        threadId,
        payload: {
          state: "ready",
        },
        providerRefs: {},
      });

      let streamFiber: Fiber.Fiber<void, never>;
      streamFiber = runFork(
        Effect.exit(runSdkStream(context)).pipe(
          Effect.flatMap((exit) => {
            if (context.stopped) {
              return Effect.void;
            }
            if (context.streamFiber === streamFiber) {
              context.streamFiber = undefined;
            }
            return handleStreamExit(context, exit).pipe(
              Effect.catch((cause) =>
                Effect.logError("Failed to close Claude runtime stream.", { cause }),
              ),
            );
          }),
        ),
      );
      context.streamFiber = streamFiber;
      streamFiber.addObserver(() => {
        if (context.streamFiber === streamFiber) {
          context.streamFiber = undefined;
        }
      });

      return {
        ...session,
      };
    },
  );

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;

    // A sendTurn while a real turn is running is a steer: the message is
    // queued into the live SDK agent loop and the work continues as the same
    // turn — no synthetic turn boundary. Stale synthetic turns (from
    // background agent responses between user prompts) are auto-closed
    // instead, so they don't block the user's next turn.
    const steeringTurnState =
      context.turnState && context.turnState.synthetic !== true ? context.turnState : null;
    if (context.turnState && steeringTurnState === null) {
      yield* completeTurn(context, "completed");
    }

    if (modelSelection?.model) {
      const apiModelId = resolveClaudeApiModelId(modelSelection);
      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toRequestError(PROVIDER, input.threadId, "turn/setModel", cause),
        });
        context.currentApiModelId = apiModelId;
      }
      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
    }

    // Apply interaction mode by switching the SDK's permission mode.
    // "plan" maps directly to the SDK's "plan" permission mode;
    // "default" restores the session's original permission mode.
    // When interactionMode is absent we leave the current mode unchanged.
    if (input.interactionMode === "plan") {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode("plan"),
        catch: (cause) => toRequestError(PROVIDER, input.threadId, "turn/setPermissionMode", cause),
      });
    } else if (input.interactionMode === "default") {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode(context.basePermissionMode ?? "default"),
        catch: (cause) => toRequestError(PROVIDER, input.threadId, "turn/setPermissionMode", cause),
      });
    }

    const turnId = steeringTurnState?.turnId ?? TurnId.make(yield* randomUUIDv4);
    if (steeringTurnState === null) {
      const turnState: ClaudeTurnState = {
        turnId,
        startedAt: yield* nowIso,
        items: [],
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        nextSyntheticAssistantBlockIndex: -1,
      };

      const updatedAt = yield* nowIso;
      context.turnState = turnState;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt,
      };

      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: modelSelection?.model ? { model: modelSelection.model } : {},
        providerRefs: {},
      });
    }

    // Keep the one-shot flag set until the prompt is successfully queued so a
    // validation / offer failure can still attach the note on the next attempt.
    const appendResumeDeadShellNote = context.pendingResumeDeadShellNote;

    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      boundInstanceId,
      provider: PROVIDER,
      appendResumeDeadShellNote,
      getModelCapabilities: options?.getModelCapabilities,
    }).pipe(
      Effect.mapError((cause) => toRequestError(PROVIDER, input.threadId, "turn/start", cause)),
    );

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(
      Effect.mapError((cause) => toRequestError(PROVIDER, input.threadId, "turn/start", cause)),
    );

    if (appendResumeDeadShellNote) {
      context.pendingResumeDeadShellNote = false;
    }

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () => context.query.interrupt(),
        catch: (cause) => toRequestError(PROVIDER, threadId, "turn/interrupt", cause),
      });
    },
  );

  /**
   * Stop one subagent task via the Claude Agent SDK. If the SDK does not emit
   * a terminal task event within a short grace period, synthesize
   * task.completed status "stopped" so the UI settles.
   */
  const stopTask: ClaudeAdapterShape["stopTask"] = Effect.fn("stopTask")(
    function* (threadId, taskId) {
      const context = yield* requireSession(threadId);
      yield* Effect.tryPromise({
        try: () => context.query.stopTask(taskId),
        catch: (cause) => toRequestError(PROVIDER, threadId, "task/stop", cause),
      });

      // Safety net: race a short wait against natural terminal emission.
      // Detached so the RPC returns immediately and does not require a Scope.
      yield* Effect.forkDetach(
        Effect.sleep(STOP_TASK_TERMINAL_GRACE).pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              if (context.stopped || !context.openTaskIds.has(taskId)) {
                return;
              }
              context.openTaskIds.delete(taskId);
              context.syntheticallyStoppedTaskIds.add(taskId);
              forgetTaskToolInputForTask(context, taskId);
              const stamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "task.completed",
                eventId: stamp.eventId,
                provider: PROVIDER,
                createdAt: stamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                payload: {
                  taskId: RuntimeTaskId.make(taskId),
                  status: "stopped",
                  summary: "Task stopped (stopTask grace elapsed).",
                },
                providerRefs: nativeProviderRefs(context),
                raw: {
                  source: "claude.sdk.message",
                  method: "claude/synthetic/task_stopped",
                  payload: { taskId, reason: "stopTask grace elapsed" },
                },
              });
            }),
          ),
          Effect.catchCause(() => Effect.void),
        ),
      );
    },
  );

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      const nextLength = Math.max(0, context.turns.length - numTurns);
      context.turns.splice(nextLength);
      yield* updateResumeCursor(context);
      return yield* snapshotThread(context);
    },
  );

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }

      context.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending.decision, decision);
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: true,
        }),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: false,
        }),
      { discard: true },
    ).pipe(
      Effect.catch((cause) =>
        Effect.logError("Failed to emit Claude session shutdown event.", { cause }),
      ),
      Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    stopTask,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ClaudeAdapterShape;
});
