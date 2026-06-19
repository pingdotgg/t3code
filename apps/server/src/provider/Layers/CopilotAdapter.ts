import { randomUUID } from "node:crypto";

import type {
  CopilotClient,
  CopilotSession,
  ContextTier,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import {
  EventId,
  type CopilotSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { DateTime, Deferred, Effect, Path, Predicate, PubSub, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { createCopilotClient, trimOrUndefined } from "../copilotRuntime.ts";
import {
  classifyCopilotToolItemType,
  isReadOnlyCopilotToolName,
} from "./CopilotToolClassification.ts";
import {
  commandLooksLikeCopilotPatchEdit,
  extractCopilotApplyPatchEdit,
  hasCopilotApplyPatchEdit,
  hasPatchHeaderShape,
  hasUnifiedDiffShape,
  stripCopilotShellCompletionControlLines,
} from "./CopilotPatchDetection.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_RESUME_SCHEMA_VERSION = 1 as const;
const SDK_TURN_REPLAY_THRESHOLD_MS = 1_000;

type CopilotMode = "interactive" | "plan" | "autopilot";
type CopilotReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;
type CopilotContextTier = ContextTier;
type CopilotUserInputRequest = Parameters<NonNullable<SessionConfig["onUserInputRequest"]>>[0];
type CopilotUserInputResponse = Awaited<
  ReturnType<NonNullable<SessionConfig["onUserInputRequest"]>>
>;
type SessionPermissionRequestedEvent = Extract<SessionEvent, { type: "permission.requested" }>;
type SessionStartedEvent = Extract<SessionEvent, { type: "session.start" }>;
type SessionResumedEvent = Extract<SessionEvent, { type: "session.resume" }>;
type SessionUserInputRequestedEvent = Extract<SessionEvent, { type: "user_input.requested" }>;
type SessionUserInputCompletedEvent = Extract<SessionEvent, { type: "user_input.completed" }>;
type SessionPermissionRequest = SessionPermissionRequestedEvent["data"]["permissionRequest"];
type SessionApprovalDecision = Extract<PermissionRequestResult, { kind: "approve-for-session" }>;
type SessionApproval = NonNullable<SessionApprovalDecision["approval"]>;
type CopilotTaskStatus = "running" | "idle" | "completed" | "failed" | "cancelled";
type CopilotTaskInfo = {
  readonly id?: string;
  readonly type?: string;
  readonly description: string;
  readonly status: CopilotTaskStatus;
  readonly agentType?: string;
  readonly command?: string;
  readonly prompt?: string;
  readonly latestResponse?: string;
  readonly result?: string;
  readonly error?: string;
};
type CopilotTaskList = {
  readonly tasks: ReadonlyArray<CopilotTaskInfo>;
};
type CopilotBackgroundTasksRpc = {
  readonly backgroundTasks?: {
    readonly list?: () => Promise<CopilotTaskList>;
  };
};

type PlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

interface CopilotTaskState {
  description: string;
  status: CopilotTaskStatus;
}

export interface CopilotAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly baseDirectory?: string;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface CopilotTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface PendingPermissionHandler {
  readonly signature: string;
  readonly deferred: Deferred.Deferred<PermissionRequestResult>;
}

interface PendingUserInputHandler {
  readonly signature: string;
  readonly deferred: Deferred.Deferred<CopilotUserInputResponse>;
}

interface PendingPermissionBinding {
  readonly requestId: string;
  readonly requestType:
    | "command_execution_approval"
    | "file_read_approval"
    | "file_change_approval";
  readonly turnId?: TurnId | undefined;
  readonly permissionRequest: SessionPermissionRequest;
  readonly promptRequest: SessionPermissionRequestedEvent["data"]["promptRequest"] | undefined;
  readonly deferred: Deferred.Deferred<PermissionRequestResult>;
}

interface PendingUserInputBinding {
  readonly requestId: string;
  readonly question: string;
  readonly choices: ReadonlyArray<string>;
  readonly allowFreeform: boolean;
  readonly deferred: Deferred.Deferred<CopilotUserInputResponse>;
}

interface ToolMeta {
  readonly toolName: string;
  readonly itemType:
    | "command_execution"
    | "file_change"
    | "mcp_tool_call"
    | "dynamic_tool_call"
    | "collab_agent_tool_call"
    | "web_search"
    | "image_view";
  readonly command?: string;
}

interface CopilotToolExecutionItem {
  readonly type: "tool_execution";
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly itemType?: ToolMeta["itemType"];
  readonly success: boolean;
  readonly detail?: string;
}

interface CopilotSessionContext {
  readonly threadId: ThreadId;
  readonly client: CopilotClient;
  readonly sdkSession: CopilotSession;
  session: ProviderSession;
  readonly cwd: string;
  readonly turns: Array<CopilotTurnSnapshot>;
  readonly queuedTurnIds: Array<TurnId>;
  readonly turnQueuedAtMsByTurnId: Map<TurnId, number>;
  readonly sdkTurnIdsToTurnIds: Map<string, TurnId>;
  readonly completedTurnIds: Set<TurnId>;
  readonly turnUsageByTurnId: Map<TurnId, ThreadTokenUsageSnapshot>;
  readonly pendingPermissionHandlersBySignature: Map<string, Array<PendingPermissionHandler>>;
  readonly pendingPermissionEventsBySignature: Map<
    string,
    Array<SessionPermissionRequestedEvent["data"]>
  >;
  readonly pendingPermissionBindings: Map<string, PendingPermissionBinding>;
  readonly pendingUserInputHandlersBySignature: Map<string, Array<PendingUserInputHandler>>;
  readonly pendingUserInputEventsBySignature: Map<
    string,
    Array<SessionUserInputRequestedEvent["data"]>
  >;
  readonly pendingUserInputBindings: Map<string, PendingUserInputBinding>;
  readonly toolMetaById: Map<string, ToolMeta>;
  readonly turnIdByProviderItemId: Map<string, TurnId>;
  readonly emittedTextByItemId: Map<string, string>;
  readonly assistantItemIdByTurnId: Map<TurnId, string>;
  readonly pendingTaskCompletionTextByTurnId: Map<TurnId, string>;
  readonly emittedTurnDiffByTurnId: Map<TurnId, string>;
  readonly copilotTasks: Map<string, CopilotTaskState>;
  readonly turnIdsWithAssistantText: Set<TurnId>;
  readonly startedItemIds: Set<string>;
  activeTurnId: TurnId | undefined;
  activeSdkTurnId: string | undefined;
  activeSdkTurnKey: string | undefined;
  eventChain: Promise<void>;
  stopped: boolean;
}

const APPROVED_PERMISSION_RESULT = { kind: "approve-once" } satisfies PermissionRequestResult;
const DENIED_PERMISSION_RESULT = {
  kind: "reject",
} satisfies PermissionRequestResult;
const EMPTY_USER_INPUT_RESPONSE = {
  answer: "",
  wasFreeform: true,
} satisfies CopilotUserInputResponse;

function nowIso(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

function parseCopilotResumeCursor(raw: unknown): { sessionId: string } | undefined {
  if (
    !Predicate.hasProperty(raw, "schemaVersion") ||
    raw.schemaVersion !== COPILOT_RESUME_SCHEMA_VERSION
  ) {
    return undefined;
  }
  if (!Predicate.hasProperty(raw, "sessionId") || !Predicate.isString(raw.sessionId)) {
    return undefined;
  }
  const sessionId = raw.sessionId.trim();
  return sessionId.length > 0 ? { sessionId } : undefined;
}

function toCopilotResumeCursor(sessionId: string): { schemaVersion: 1; sessionId: string } {
  return {
    schemaVersion: COPILOT_RESUME_SCHEMA_VERSION,
    sessionId,
  };
}

function readTrimmedStringProperty(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? trimOrUndefined(value) : undefined;
}

function providerRefsFromSdkEvent(
  raw: SessionEvent | undefined,
  requestId: string | undefined,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: {
    providerTurnId?: string;
    providerItemId?: ProviderItemId;
    providerRequestId?: string;
  } = {};

  if (requestId) {
    refs.providerRequestId = requestId;
  }

  const data = raw ? stringRecord(raw.data) : undefined;
  if (data) {
    const providerTurnId = readTrimmedStringProperty(data, "turnId");
    if (providerTurnId) {
      refs.providerTurnId = providerTurnId;
    }

    const providerRequestId = readTrimmedStringProperty(data, "requestId");
    if (providerRequestId) {
      refs.providerRequestId = providerRequestId;
    }

    const providerItemId =
      readTrimmedStringProperty(data, "messageId") ??
      readTrimmedStringProperty(data, "reasoningId") ??
      readTrimmedStringProperty(data, "toolCallId") ??
      readTrimmedStringProperty(stringRecord(data.permissionRequest) ?? {}, "toolCallId");
    if (providerItemId) {
      refs.providerItemId = ProviderItemId.make(providerItemId);
    }
  }

  return Object.keys(refs).length > 0 ? refs : undefined;
}

function createBaseEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: SessionEvent | undefined;
}) {
  const providerRefs = providerRefsFromSdkEvent(input.raw, input.requestId);
  return {
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(providerRefs ? { providerRefs } : {}),
    ...(input.raw
      ? {
          raw: {
            source: "copilot.sdk.event" as const,
            method: input.raw.type,
            payload: input.raw,
          },
        }
      : {}),
  };
}

function ensureTurnSnapshot(context: CopilotSessionContext, turnId: TurnId): CopilotTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }
  const created: CopilotTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: CopilotSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  ensureTurnSnapshot(context, turnId).items.push(item);
}

function processError(
  threadId: ThreadId,
  detail: string,
  cause?: unknown,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function validationError(operation: string, issue: string): ProviderAdapterValidationError {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation,
    issue,
  });
}

function sessionClosedError(threadId: ThreadId): ProviderAdapterSessionClosedError {
  return new ProviderAdapterSessionClosedError({
    provider: PROVIDER,
    threadId,
  });
}

function sessionNotFoundError(threadId: ThreadId): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
  });
}

function detailFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function isCopilotSessionNotFoundError(error: ProviderAdapterProcessError, sessionId: string) {
  const detail = error.detail.toLowerCase();
  return detail.includes("session not found") && detail.includes(sessionId.toLowerCase());
}

function requireSessionContext(
  sessions: ReadonlyMap<ThreadId, CopilotSessionContext>,
  threadId: ThreadId,
): Effect.Effect<
  CopilotSessionContext,
  ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError
> {
  return Effect.gen(function* () {
    const context = sessions.get(threadId);
    if (!context) {
      return yield* sessionNotFoundError(threadId);
    }
    if (context.stopped) {
      return yield* sessionClosedError(threadId);
    }
    return context;
  });
}

function requestedCopilotMode(input: {
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode?: ProviderSendTurnInput["interactionMode"] | undefined;
}): CopilotMode {
  if (input.interactionMode === "plan") {
    return "plan";
  }
  return input.runtimeMode === "full-access" ? "autopilot" : "interactive";
}

function permissionAutoApprovedByRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
  request: PermissionRequest,
): boolean {
  switch (runtimeMode) {
    case "full-access":
      return true;
    case "auto-accept-edits":
      return request.kind === "write";
    case "approval-required":
      return false;
  }
}

function mapPermissionRequestType(
  request: SessionPermissionRequest,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" {
  switch (request.kind) {
    case "read":
      return "file_read_approval";
    case "write":
      return "file_change_approval";
    default:
      return "command_execution_approval";
  }
}

function toolCallIdFromPermissionRequest(request: SessionPermissionRequest): string | undefined {
  if (!Predicate.hasProperty(request, "toolCallId") || !Predicate.isString(request.toolCallId)) {
    return undefined;
  }
  return trimOrUndefined(request.toolCallId);
}

function permissionDetail(request: SessionPermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return trimOrUndefined(request.fullCommandText) ?? trimOrUndefined(request.intention);
    case "write":
      return trimOrUndefined(request.fileName) ?? trimOrUndefined(request.intention);
    case "read":
      return trimOrUndefined(request.path) ?? trimOrUndefined(request.intention);
    case "mcp":
      return trimOrUndefined(request.toolTitle) ?? `${request.serverName}:${request.toolName}`;
    case "url":
      return trimOrUndefined(request.url) ?? trimOrUndefined(request.intention);
    case "memory":
      return trimOrUndefined(request.subject);
    case "custom-tool":
      return trimOrUndefined(request.toolName) ?? trimOrUndefined(request.toolDescription);
    case "hook":
      return trimOrUndefined(request.hookMessage) ?? trimOrUndefined(request.toolName);
    case "extension-management":
      return [request.operation, request.extensionName]
        .map((part) => trimOrUndefined(part))
        .filter(Boolean)
        .join(" ");
    case "extension-permission-access":
      return [request.extensionName, ...request.capabilities]
        .map((part) => trimOrUndefined(part))
        .filter(Boolean)
        .join(" ");
    default:
      return undefined;
  }
}

function sessionApprovalDecisionFromPermissionRequest(
  request: SessionPermissionRequest,
  promptRequest: SessionPermissionRequestedEvent["data"]["promptRequest"] | undefined,
): SessionApprovalDecision | undefined {
  const approve = (approval: SessionApproval): SessionApprovalDecision => ({
    kind: "approve-for-session",
    approval,
  });

  switch (request.kind) {
    case "shell": {
      if (!request.canOfferSessionApproval) {
        return undefined;
      }
      const commandIdentifiers =
        promptRequest?.kind === "commands"
          ? promptRequest.commandIdentifiers
          : request.commands.map((command) => command.identifier);
      const identifiers = commandIdentifiers.map((identifier) => identifier.trim()).filter(Boolean);
      return identifiers.length > 0
        ? approve({ kind: "commands", commandIdentifiers: identifiers })
        : undefined;
    }
    case "write":
      return request.canOfferSessionApproval ? approve({ kind: "write" }) : undefined;
    case "read":
      return approve({ kind: "read" });
    case "mcp":
      return approve({ kind: "mcp", serverName: request.serverName, toolName: request.toolName });
    case "url": {
      try {
        const domain = new URL(request.url).hostname.trim();
        return domain ? { kind: "approve-for-session", domain } : undefined;
      } catch {
        return undefined;
      }
    }
    case "memory":
      return approve({ kind: "memory" });
    case "custom-tool":
      return approve({ kind: "custom-tool", toolName: request.toolName });
    case "extension-management": {
      const operation = trimOrUndefined(request.operation);
      return approve({
        kind: "extension-management",
        ...(operation ? { operation } : {}),
      });
    }
    case "extension-permission-access":
      return approve({
        kind: "extension-permission-access",
        extensionName: request.extensionName,
      });
    case "hook":
      return undefined;
  }
}

function isPermissionCompletionApproved(result: PermissionRequestResult): boolean {
  const kind = result.kind as string;
  return (
    kind === "approved" ||
    kind.startsWith("approved-") ||
    kind === "approve-once" ||
    kind === "approve-for-session"
  );
}

function permissionSignature(request: SessionPermissionRequest): string {
  switch (request.kind) {
    case "shell":
      return JSON.stringify([
        request.kind,
        request.toolCallId ?? null,
        request.fullCommandText ?? null,
        request.intention ?? null,
      ]);
    case "write":
      return JSON.stringify([
        request.kind,
        request.toolCallId ?? null,
        request.fileName ?? null,
        request.diff ?? null,
      ]);
    case "read":
      return JSON.stringify([request.kind, request.toolCallId ?? null, request.path ?? null]);
    case "mcp":
      return JSON.stringify([
        request.kind,
        request.toolCallId ?? null,
        request.serverName ?? null,
        request.toolName ?? null,
        request.args ?? null,
      ]);
    case "url":
      return JSON.stringify([request.kind, request.toolCallId ?? null, request.url ?? null]);
    case "memory":
      return JSON.stringify([
        request.kind,
        request.toolCallId ?? null,
        request.subject ?? null,
        request.fact ?? null,
      ]);
    case "custom-tool":
      return JSON.stringify([
        request.kind,
        request.toolCallId ?? null,
        request.toolName ?? null,
        request.args ?? null,
      ]);
    case "hook":
      return JSON.stringify([
        request.kind,
        request.toolCallId ?? null,
        request.toolName ?? null,
        request.toolArgs ?? null,
        request.hookMessage ?? null,
      ]);
    case "extension-management":
      return JSON.stringify([
        request.kind,
        request.toolCallId ?? null,
        request.operation ?? null,
        request.extensionName ?? null,
      ]);
    case "extension-permission-access":
      return JSON.stringify([
        request.kind,
        request.toolCallId ?? null,
        request.extensionName ?? null,
        request.capabilities ?? null,
      ]);
    default:
      return JSON.stringify(request);
  }
}

function userInputSignature(input: {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
}): string {
  return JSON.stringify([input.question, input.choices ?? [], input.allowFreeform ?? true]);
}

function updateProviderSession(
  context: CopilotSessionContext,
  patch: Partial<ProviderSession>,
): void {
  context.session = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  };
}

function readyStatusAfterTurnCompletion(
  context: CopilotSessionContext,
): Extract<ProviderSession["status"], "running" | "ready"> {
  return context.queuedTurnIds.length > 0 ? "running" : "ready";
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function deltaFromBufferedText(previous: string | undefined, next: string): string {
  return next.slice(commonPrefixLength(previous ?? "", next));
}

function toolItemType(
  toolName: string,
  mcpServerName?: string,
  arguments_?: unknown,
): ToolMeta["itemType"] {
  return classifyCopilotToolItemType({
    toolName,
    ...(mcpServerName ? { mcpServerName } : {}),
    ...(arguments_ !== undefined ? { arguments: arguments_ } : {}),
  });
}

function isTaskCompleteTool(toolName: string | undefined): boolean {
  return toolName?.toLowerCase().replace(/[\s_-]+/g, "") === "taskcomplete";
}

function isApplyPatchTool(toolName: string | undefined): boolean {
  return toolName?.toLowerCase().replace(/[\s_-]+/g, "") === "applypatch";
}

function completedToolDiffText(
  toolMeta: ToolMeta | undefined,
  detail: string | undefined,
): string | undefined {
  const normalized = trimOrUndefined(detail);
  if (!normalized) {
    return undefined;
  }
  const applyPatchDiff =
    extractCopilotApplyPatchEdit(normalized) ?? extractCopilotApplyPatchEdit(toolMeta?.command);
  if (isApplyPatchTool(toolMeta?.toolName)) {
    return applyPatchDiff;
  }
  if (toolMeta?.itemType === "file_change" && applyPatchDiff) {
    return applyPatchDiff;
  }
  if (toolMeta?.itemType !== "command_execution" && toolMeta?.itemType !== "file_change") {
    return undefined;
  }
  const diffCandidate = stripCopilotShellCompletionControlLines(normalized);
  if (!hasUnifiedDiffShape(diffCandidate)) {
    return undefined;
  }
  return parseTurnDiffFilesFromUnifiedDiff(diffCandidate).length > 0 ? diffCandidate : undefined;
}

function copilotBackgroundTasksList(
  session: CopilotSession,
): (() => Promise<CopilotTaskList>) | undefined {
  const list = (session.rpc as typeof session.rpc & CopilotBackgroundTasksRpc).backgroundTasks
    ?.list;
  return list;
}

function normalizeCopilotTaskStatus(status: CopilotTaskStatus): PlanStep["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "running":
    case "idle":
      return "inProgress";
    case "failed":
    case "cancelled":
      return "pending";
  }
}

function completedCopilotTaskStatus(
  status: CopilotTaskStatus,
): "completed" | "failed" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "running":
    case "idle":
      return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function copilotTaskId(task: CopilotTaskInfo): string | undefined {
  return readString(task.id);
}

function copilotTaskType(task: CopilotTaskInfo): string | undefined {
  return readString(task.type) ?? readString(task.agentType);
}

function copilotTaskDescription(task: CopilotTaskInfo): string {
  return (
    readString(task.description) ??
    readString(task.command) ??
    readString(task.prompt) ??
    readString(task.latestResponse) ??
    "Task"
  );
}

function copilotTaskProgressSummary(status: CopilotTaskStatus): string {
  return status === "idle" ? "Task idle" : "Task running";
}

function copilotTaskCompletionSummary(task: CopilotTaskInfo): string | undefined {
  return (
    readString(task.error) ??
    readString(task.result) ??
    readString(task.latestResponse) ??
    copilotTaskDescription(task)
  );
}

function copilotTaskStatusSuffix(status: CopilotTaskStatus): string {
  switch (status) {
    case "failed":
      return " (failed)";
    case "cancelled":
      return " (cancelled)";
    case "running":
    case "idle":
    case "completed":
      return "";
  }
}

function planStepsFromCopilotTasks(tasks: ReadonlyArray<CopilotTaskInfo>): PlanStep[] {
  return tasks.map((task) => {
    const description = copilotTaskDescription(task);
    return {
      step: `${description}${copilotTaskStatusSuffix(task.status)}`,
      status: normalizeCopilotTaskStatus(task.status),
    };
  });
}

function isTodoTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized.includes("todo");
}

function normalizeTodoStatus(value: unknown): PlanStep["status"] {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "completed" || normalized === "done") {
    return "completed";
  }
  if (
    normalized === "in_progress" ||
    normalized === "inprogress" ||
    normalized === "running" ||
    normalized === "active"
  ) {
    return "inProgress";
  }
  return "pending";
}

function extractPlanStepsFromTodoInput(input: Record<string, unknown>): PlanStep[] | undefined {
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) {
    return undefined;
  }
  const steps = todos.flatMap((todo): Array<PlanStep> => {
    if (!isStringRecord(todo)) {
      return [];
    }
    const step = readString(todo.content) ?? readString(todo.title) ?? readString(todo.task);
    return [
      {
        step: step ?? "Task",
        status: normalizeTodoStatus(todo.status),
      },
    ];
  });
  return steps.length > 0 ? steps : undefined;
}

function toolStreamKind(
  itemType: ToolMeta["itemType"] | undefined,
): "command_output" | "file_change_output" | "unknown" {
  if (itemType === "command_execution") {
    return "command_output";
  }
  if (itemType === "file_change") {
    return "file_change_output";
  }
  return "unknown";
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, unknown> | undefined {
  return isStringRecord(value) ? value : undefined;
}

function commandFromToolArguments(arguments_: unknown): string | undefined {
  const args = stringRecord(arguments_);
  if (!args) {
    return undefined;
  }

  const candidates = [
    args.command,
    args.cmd,
    args.fullCommandText,
    args.commandText,
    stringRecord(args.input)?.command,
  ];
  for (const candidate of candidates) {
    const command = trimOrUndefined(typeof candidate === "string" ? candidate : undefined);
    if (command) {
      return command;
    }
  }
  return undefined;
}

function toolLifecycleTitle(toolMeta: ToolMeta | undefined): string {
  if (toolMeta?.itemType === "command_execution") {
    const command = trimOrUndefined(toolMeta.command);
    return command ? `Ran command: ${truncateSingleLine(command, 96)}` : "Ran command";
  }
  if (toolMeta?.itemType === "file_change") {
    return isApplyPatchTool(toolMeta.toolName) || commandLooksLikeCopilotPatchEdit(toolMeta.command)
      ? "Applied patch"
      : (toolMeta.toolName ?? "Updated files");
  }
  return toolMeta?.toolName ?? "tool";
}

function truncateSingleLine(value: string, max = 120): string {
  const singleLine = value.replace(/\r\n/g, "\n").replace(/\n+/g, " ").trim();
  if (singleLine.length <= max) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
}

function normalizedToolCompletionDetail(
  toolMeta: ToolMeta | undefined,
  detail: string | undefined,
): string | undefined {
  const normalized = trimOrUndefined(detail);
  if (!normalized) {
    return undefined;
  }
  if (toolMeta?.itemType === "command_execution") {
    const withoutControlLines = stripCopilotShellCompletionControlLines(normalized);
    return trimOrUndefined(withoutControlLines);
  }
  return normalized;
}

function toolLifecycleDataKind(toolMeta: ToolMeta | undefined): "edit" | "read" | undefined {
  if (!toolMeta) {
    return undefined;
  }
  if (toolMeta.itemType === "file_change") {
    return "edit";
  }
  if (isReadOnlyCopilotToolName(toolMeta.toolName)) {
    return "read";
  }
  return undefined;
}

function toolLifecycleData(input: {
  readonly toolCallId: string;
  readonly toolMeta: ToolMeta | undefined;
  readonly arguments?: Record<string, unknown> | undefined;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly toolTelemetry?: unknown;
}): Record<string, unknown> {
  const argumentsData: Record<string, unknown> = input.arguments ? { ...input.arguments } : {};
  const kind = toolLifecycleDataKind(input.toolMeta);
  if (input.toolMeta?.itemType !== "command_execution") {
    delete argumentsData.command;
    delete argumentsData.cmd;
    delete argumentsData.fullCommandText;
    delete argumentsData.commandText;
  }
  return {
    ...argumentsData,
    ...(kind ? { kind } : {}),
    toolCallId: input.toolCallId,
    ...(input.toolMeta?.toolName ? { toolName: input.toolMeta.toolName } : {}),
    ...(input.toolMeta?.itemType === "command_execution" && input.toolMeta.command
      ? { command: input.toolMeta.command }
      : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.toolTelemetry ? { toolTelemetry: input.toolTelemetry } : {}),
  };
}

function usageSnapshotFromAssistantUsage(
  event: Extract<SessionEvent, { type: "assistant.usage" }>,
): ThreadTokenUsageSnapshot {
  const inputTokens = event.data.inputTokens ?? 0;
  const cachedInputTokens = event.data.cacheReadTokens ?? 0;
  const outputTokens = event.data.outputTokens ?? 0;
  const usedTokens = inputTokens + cachedInputTokens + outputTokens;
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens > 0
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(typeof event.data.duration === "number" && Number.isFinite(event.data.duration)
      ? { durationMs: Math.max(0, Math.round(event.data.duration)) }
      : {}),
  };
}

function usageSnapshotFromUsageInfo(
  event: Extract<SessionEvent, { type: "session.usage_info" }>,
): ThreadTokenUsageSnapshot {
  const currentTokens = Math.max(0, Math.round(event.data.currentTokens));
  return {
    usedTokens: currentTokens,
    lastUsedTokens: currentTokens,
    ...(event.data.tokenLimit > 0 ? { maxTokens: Math.round(event.data.tokenLimit) } : {}),
    ...(event.data.conversationTokens !== undefined
      ? {
          inputTokens: event.data.conversationTokens,
          lastInputTokens: event.data.conversationTokens,
        }
      : {}),
  };
}

function firstAnswerValue(answers: ProviderUserInputAnswers): string | undefined {
  for (const value of Object.values(answers)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim().length > 0);
      if (typeof first === "string") {
        return first.trim();
      }
    }
  }
  return undefined;
}

function answerFromUserInput(
  binding: PendingUserInputBinding,
  answers: ProviderUserInputAnswers,
): CopilotUserInputResponse {
  const preferredAnswer =
    firstAnswerValue(answers) ??
    (binding.choices.length > 0 ? binding.choices[0] : undefined) ??
    "";
  const normalizedChoices = new Set(binding.choices.map((choice) => choice.trim()));
  const wasFreeform =
    normalizedChoices.size === 0 ? true : !normalizedChoices.has(preferredAnswer.trim());
  return {
    answer: preferredAnswer,
    wasFreeform,
  };
}

function answersFromCompletedUserInput(
  data: SessionUserInputCompletedEvent["data"],
): ProviderUserInputAnswers {
  return {
    answer: data.answer ?? "",
  };
}

function settlePendingPermissionHandlers(
  context: CopilotSessionContext,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    for (const handlers of context.pendingPermissionHandlersBySignature.values()) {
      for (const handler of handlers) {
        yield* Deferred.succeed(handler.deferred, DENIED_PERMISSION_RESULT).pipe(Effect.ignore);
      }
    }
    context.pendingPermissionHandlersBySignature.clear();
    context.pendingPermissionEventsBySignature.clear();

    for (const binding of context.pendingPermissionBindings.values()) {
      yield* Deferred.succeed(binding.deferred, DENIED_PERMISSION_RESULT).pipe(Effect.ignore);
    }
    context.pendingPermissionBindings.clear();
  });
}

function settlePendingUserInputs(context: CopilotSessionContext): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    for (const handlers of context.pendingUserInputHandlersBySignature.values()) {
      for (const handler of handlers) {
        yield* Deferred.succeed(handler.deferred, EMPTY_USER_INPUT_RESPONSE).pipe(Effect.ignore);
      }
    }
    context.pendingUserInputHandlersBySignature.clear();
    context.pendingUserInputEventsBySignature.clear();

    for (const binding of context.pendingUserInputBindings.values()) {
      yield* Deferred.succeed(binding.deferred, EMPTY_USER_INPUT_RESPONSE).pipe(Effect.ignore);
    }
    context.pendingUserInputBindings.clear();
  });
}

function latestTurnId(context: CopilotSessionContext): TurnId | undefined {
  return context.turns.at(-1)?.id;
}

function epochMsFromIso(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSdkEventBeforeQueuedTurn(
  context: CopilotSessionContext,
  turnId: TurnId,
  timestamp: string | undefined,
): boolean {
  const eventAtMs = epochMsFromIso(timestamp);
  const turnQueuedAtMs = context.turnQueuedAtMsByTurnId.get(turnId);
  return (
    eventAtMs !== undefined &&
    turnQueuedAtMs !== undefined &&
    eventAtMs + SDK_TURN_REPLAY_THRESHOLD_MS < turnQueuedAtMs
  );
}

function sdkTurnMappingKey(agentId: string | undefined, sdkTurnId: string): string {
  return agentId ? `${agentId}:${sdkTurnId}` : sdkTurnId;
}

function removeQueuedTurn(context: CopilotSessionContext, turnId: TurnId): void {
  const queueIndex = context.queuedTurnIds.indexOf(turnId);
  if (queueIndex >= 0) {
    context.queuedTurnIds.splice(queueIndex, 1);
  }
}

function clearSdkTurnMappingsForTurn(context: CopilotSessionContext, turnId: TurnId): void {
  context.turnQueuedAtMsByTurnId.delete(turnId);
  for (const [sdkTurnKey, mappedTurnId] of context.sdkTurnIdsToTurnIds.entries()) {
    if (mappedTurnId === turnId) {
      context.sdkTurnIdsToTurnIds.delete(sdkTurnKey);
      if (context.activeSdkTurnKey === sdkTurnKey) {
        context.activeSdkTurnId = undefined;
        context.activeSdkTurnKey = undefined;
      }
    }
  }
}

function resolveTurnIdForSdkTurn(
  context: CopilotSessionContext,
  sdkTurnId: string,
  input?: {
    readonly timestamp?: string | undefined;
    readonly agentId?: string | undefined;
  },
): TurnId | undefined {
  const sdkTurnKey = sdkTurnMappingKey(input?.agentId, sdkTurnId);
  const existing = context.sdkTurnIdsToTurnIds.get(sdkTurnKey);
  if (existing) {
    return existing;
  }

  const activeTurnId = context.activeTurnId;
  if (activeTurnId && !isSdkEventBeforeQueuedTurn(context, activeTurnId, input?.timestamp)) {
    removeQueuedTurn(context, activeTurnId);
    context.sdkTurnIdsToTurnIds.set(sdkTurnKey, activeTurnId);
    context.activeSdkTurnId = sdkTurnId;
    context.activeSdkTurnKey = sdkTurnKey;
    updateProviderSession(context, {
      status: "running",
      activeTurnId,
    });
    return activeTurnId;
  }

  // When no T3 turn is active, a new SDK turn can start the next queued app turn.
  const nextTurnId = context.queuedTurnIds[0];
  if (!nextTurnId) {
    return undefined;
  }
  if (isSdkEventBeforeQueuedTurn(context, nextTurnId, input?.timestamp)) {
    return undefined;
  }
  context.queuedTurnIds.shift();
  context.sdkTurnIdsToTurnIds.set(sdkTurnKey, nextTurnId);
  ensureTurnSnapshot(context, nextTurnId);
  context.activeSdkTurnId = sdkTurnId;
  context.activeSdkTurnKey = sdkTurnKey;
  context.activeTurnId = nextTurnId;
  updateProviderSession(context, {
    status: "running",
    activeTurnId: nextTurnId,
  });
  return nextTurnId;
}

function resolveTurnIdForEvent(
  context: CopilotSessionContext,
  input?: {
    readonly providerItemId?: string | undefined;
    readonly sdkTurnId?: string | undefined;
    readonly sdkEventTimestamp?: string | undefined;
    readonly agentId?: string | undefined;
    readonly parentProviderItemId?: string | undefined;
    readonly allowActiveFallback?: boolean | undefined;
  },
): TurnId | undefined {
  const parentTurnId =
    input?.parentProviderItemId && context.turnIdByProviderItemId.get(input.parentProviderItemId);
  if (parentTurnId) {
    return parentTurnId;
  }
  const providerItemTurnId =
    input?.providerItemId && context.turnIdByProviderItemId.get(input.providerItemId);
  if (providerItemTurnId) {
    return providerItemTurnId;
  }
  if (input?.sdkTurnId) {
    return resolveTurnIdForSdkTurn(context, input.sdkTurnId, {
      timestamp: input.sdkEventTimestamp,
      agentId: input.agentId,
    });
  }
  if (input?.allowActiveFallback === false) {
    return undefined;
  }
  if (context.activeSdkTurnKey) {
    return context.sdkTurnIdsToTurnIds.get(context.activeSdkTurnKey) ?? context.activeTurnId;
  }
  return context.activeTurnId;
}

export const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  settings: CopilotSettings,
  options?: CopilotAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("copilot");
  const serverConfig = yield* ServerConfig;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const sessions = new Map<ThreadId, CopilotSessionContext>();
  const path = yield* Path.Path;
  const runtimeContext = yield* Effect.context();
  const runWithContext = Effect.runPromiseWith(runtimeContext);

  const emit = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);
  const emitAsync = (event: ProviderRuntimeEvent) => runWithContext(emit(event));
  const writeNativeAsync = (threadId: ThreadId, event: SessionEvent) =>
    nativeEventLogger
      ? runWithContext(
          nativeEventLogger.write({ source: "copilot.sdk.event", payload: event }, threadId),
        )
      : Promise.resolve();

  const copilotSdk = {
    startClient: (threadId: ThreadId, client: CopilotClient) =>
      Effect.tryPromise({
        try: () => client.start(),
        catch: (cause) =>
          processError(threadId, detailFromCause(cause, "Failed to start Copilot client."), cause),
      }),
    stopClient: (threadId: ThreadId, client: CopilotClient) =>
      Effect.tryPromise({
        try: () => client.stop(),
        catch: (cause) =>
          processError(threadId, detailFromCause(cause, "Failed to stop Copilot client."), cause),
      }),
    createSession: (
      threadId: ThreadId,
      client: CopilotClient,
      config: SessionConfig,
    ): Effect.Effect<CopilotSession, ProviderAdapterProcessError> =>
      Effect.tryPromise({
        try: () => client.createSession(config),
        catch: (cause) =>
          processError(
            threadId,
            detailFromCause(cause, "Failed to create Copilot session."),
            cause,
          ),
      }),
    resumeSession: (
      threadId: ThreadId,
      client: CopilotClient,
      sessionId: string,
      config: SessionConfig,
    ): Effect.Effect<CopilotSession, ProviderAdapterProcessError> =>
      Effect.tryPromise({
        try: () => client.resumeSession(sessionId, config),
        catch: (cause) =>
          processError(
            threadId,
            detailFromCause(cause, "Failed to resume Copilot session."),
            cause,
          ),
      }),
    setMode: (
      context: CopilotSessionContext,
      mode: CopilotMode,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.tryPromise({
        try: () => context.sdkSession.rpc.mode.set({ mode }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.mode.set",
            detail: detailFromCause(cause, "Failed to update Copilot mode."),
            cause,
          }),
      }),
    readPlan: (
      context: CopilotSessionContext,
    ): Effect.Effect<string, ProviderAdapterRequestError> =>
      Effect.tryPromise({
        try: async () => (await context.sdkSession.rpc.plan.read()).content ?? "",
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.plan.read",
            detail: detailFromCause(cause, "Failed to read Copilot plan."),
            cause,
          }),
      }),
    readBackgroundTasks: (
      context: CopilotSessionContext,
    ): Effect.Effect<CopilotTaskList | undefined, ProviderAdapterRequestError> =>
      Effect.tryPromise({
        try: () => copilotBackgroundTasksList(context.sdkSession)?.() ?? Promise.resolve(undefined),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.backgroundTasks.list",
            detail: detailFromCause(cause, "Failed to read Copilot background tasks."),
            cause,
          }),
      }),
    setModel: (
      context: CopilotSessionContext,
      model: string,
      reasoningEffort?: CopilotReasoningEffort | undefined,
      contextTier?: CopilotContextTier | undefined,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.tryPromise({
        try: () =>
          context.sdkSession.setModel(model, {
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(contextTier ? { contextTier } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.setModel",
            detail: detailFromCause(cause, "Failed to update Copilot model."),
            cause,
          }),
      }),
    send: (
      context: CopilotSessionContext,
      messageOptions: MessageOptions,
    ): Effect.Effect<string, ProviderAdapterRequestError> =>
      Effect.tryPromise({
        try: () => context.sdkSession.send(messageOptions),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.send",
            detail: detailFromCause(cause, "Failed to send Copilot turn."),
            cause,
          }),
      }),
    abort: (context: CopilotSessionContext): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.tryPromise({
        try: () => context.sdkSession.abort(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.abort",
            detail: detailFromCause(cause, "Failed to abort Copilot turn."),
            cause,
          }),
      }),
    disconnect: (
      context: CopilotSessionContext,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.tryPromise({
        try: () => context.sdkSession.disconnect(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.disconnect",
            detail: detailFromCause(cause, "Failed to disconnect Copilot session."),
            cause,
          }),
      }),
  } as const;

  const enqueueSdkEvent = (context: CopilotSessionContext, event: SessionEvent) => {
    context.eventChain = context.eventChain
      .then(async () => {
        await writeNativeAsync(context.threadId, event);
        await handleSdkEvent(context, event);
      })
      .catch(async (error) => {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message.trim()
            : "Copilot event handling failed.";
        updateProviderSession(context, {
          status: "error",
          lastError: message,
        });
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
          }),
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error",
            detail: {
              error,
              sourceEventType: event.type,
            },
          },
        });
      });
  };

  const emitTurnCompleted = async (
    context: CopilotSessionContext,
    turnId: TurnId,
    status: ProviderRuntimeTurnStatus,
    input?: {
      readonly stopReason?: string | null | undefined;
      readonly errorMessage?: string | undefined;
      readonly raw?: SessionEvent | undefined;
    },
  ) => {
    // Copilot can report duplicate idle/error signals around the same user turn;
    // keep the public runtime lifecycle canonical and idempotent.
    if (context.completedTurnIds.has(turnId)) {
      context.pendingTaskCompletionTextByTurnId.delete(turnId);
      context.turnIdsWithAssistantText.delete(turnId);
      return;
    }
    context.completedTurnIds.add(turnId);
    context.pendingTaskCompletionTextByTurnId.delete(turnId);
    context.turnIdsWithAssistantText.delete(turnId);
    clearSdkTurnMappingsForTurn(context, turnId);
    if (context.activeTurnId === turnId) {
      context.activeTurnId = undefined;
    }
    updateProviderSession(context, {
      status:
        status === "failed"
          ? "error"
          : context.stopped
            ? "closed"
            : readyStatusAfterTurnCompletion(context),
      ...(status === "failed" && input?.errorMessage ? { lastError: input.errorMessage } : {}),
      activeTurnId: undefined,
    });
    await emitAsync({
      ...createBaseEvent({
        threadId: context.threadId,
        turnId,
        raw: input?.raw,
      }),
      type: "turn.completed",
      payload: {
        state: status,
        ...(input?.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
        ...(context.turnUsageByTurnId.has(turnId)
          ? { usage: context.turnUsageByTurnId.get(turnId) }
          : {}),
        ...(input?.errorMessage ? { errorMessage: input.errorMessage } : {}),
      },
    });
  };

  const emitTurnDiffUpdated = async (input: {
    readonly context: CopilotSessionContext;
    readonly turnId: TurnId;
    readonly diffText: string;
    readonly raw?: SessionEvent | undefined;
  }) => {
    const normalizedDiff = trimOrUndefined(input.diffText);
    if (!normalizedDiff) {
      return;
    }
    const hasParsedFiles = parseTurnDiffFilesFromUnifiedDiff(normalizedDiff).length > 0;
    if (
      !hasParsedFiles &&
      !hasCopilotApplyPatchEdit(normalizedDiff) &&
      !hasUnifiedDiffShape(normalizedDiff) &&
      !hasPatchHeaderShape(normalizedDiff)
    ) {
      return;
    }
    const previousDiff = input.context.emittedTurnDiffByTurnId.get(input.turnId);
    if (previousDiff === normalizedDiff) {
      return;
    }
    input.context.emittedTurnDiffByTurnId.set(input.turnId, normalizedDiff);
    await emitAsync({
      ...createBaseEvent({
        threadId: input.context.threadId,
        turnId: input.turnId,
        raw: input.raw,
      }),
      type: "turn.diff.updated",
      payload: {
        unifiedDiff: normalizedDiff,
      },
    });
  };

  const emitTextDelta = async (input: {
    readonly context: CopilotSessionContext;
    readonly turnId: TurnId;
    readonly itemId: string;
    readonly itemType: "assistant_message" | "reasoning";
    readonly streamKind: "assistant_text" | "reasoning_text";
    readonly nextText: string;
    readonly raw?: SessionEvent | undefined;
  }) => {
    if (!input.context.startedItemIds.has(input.itemId)) {
      input.context.startedItemIds.add(input.itemId);
      await emitAsync({
        ...createBaseEvent({
          threadId: input.context.threadId,
          turnId: input.turnId,
          itemId: input.itemId,
          raw: input.raw,
        }),
        type: "item.started",
        payload: {
          itemType: input.itemType,
          status: "inProgress",
        },
      });
    }

    const previousText = input.context.emittedTextByItemId.get(input.itemId);
    const delta = deltaFromBufferedText(previousText, input.nextText);
    input.context.emittedTextByItemId.set(input.itemId, input.nextText);
    if (delta.length === 0) {
      return;
    }
    if (input.itemType === "assistant_message" && input.streamKind === "assistant_text") {
      input.context.turnIdsWithAssistantText.add(input.turnId);
      input.context.assistantItemIdByTurnId.set(input.turnId, input.itemId);
    }
    await emitAsync({
      ...createBaseEvent({
        threadId: input.context.threadId,
        turnId: input.turnId,
        itemId: input.itemId,
        raw: input.raw,
      }),
      type: "content.delta",
      payload: {
        streamKind: input.streamKind,
        delta,
      },
    });
  };

  const emitPendingTaskCompletionAsAssistantMessage = async (
    context: CopilotSessionContext,
    turnId: TurnId,
    raw: SessionEvent,
  ) => {
    const content = context.pendingTaskCompletionTextByTurnId.get(turnId);
    if (!content || context.turnIdsWithAssistantText.has(turnId)) {
      return;
    }

    context.pendingTaskCompletionTextByTurnId.delete(turnId);
    const itemId = `copilot-task-completion-${String(turnId)}`;
    await emitTextDelta({
      context,
      turnId,
      itemId,
      itemType: "assistant_message",
      streamKind: "assistant_text",
      nextText: content,
      raw,
    });
    await emitAsync({
      ...createBaseEvent({
        threadId: context.threadId,
        turnId,
        itemId,
        raw,
      }),
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: content,
      },
    });
    appendTurnItem(context, turnId, {
      type: "assistant_message",
      messageId: itemId,
      content,
    });
    context.assistantItemIdByTurnId.set(turnId, itemId);
    context.turnIdsWithAssistantText.add(turnId);
  };

  const emitPermissionRequestOpened = (
    context: CopilotSessionContext,
    pending: PendingPermissionBinding,
    data: SessionPermissionRequestedEvent["data"],
  ): Effect.Effect<void> => {
    const detail = permissionDetail(data.permissionRequest);
    return emit({
      ...createBaseEvent({
        threadId: context.threadId,
        turnId: pending.turnId,
        requestId: pending.requestId,
        raw: {
          ...({
            id: pending.requestId,
            timestamp: nowIso(),
            parentId: null,
            ephemeral: true,
            type: "permission.requested",
            data,
          } satisfies SessionPermissionRequestedEvent),
        },
      }),
      type: "request.opened",
      payload: {
        requestType: pending.requestType,
        ...(detail ? { detail } : {}),
        args: data.permissionRequest,
      },
    });
  };

  const emitPermissionRequestResolved = (
    context: CopilotSessionContext,
    pending: PendingPermissionBinding,
    decision: ProviderApprovalDecision | PermissionRequestResult["kind"],
    resolution: unknown,
    raw?: SessionEvent,
  ): Effect.Effect<void> =>
    emit({
      ...createBaseEvent({
        threadId: context.threadId,
        turnId: pending.turnId,
        requestId: pending.requestId,
        raw,
      }),
      type: "request.resolved",
      payload: {
        requestType: pending.requestType,
        decision,
        resolution,
      },
    });

  const emitUserInputRequested = (
    context: CopilotSessionContext,
    requestId: string,
    request: PendingUserInputBinding,
    raw?: SessionEvent,
  ): Effect.Effect<void> => {
    const options = request.choices.map((choice) => ({
      label: choice,
      description: choice,
    }));
    const questions: ReadonlyArray<UserInputQuestion> = [
      {
        id: "answer",
        header: "Input",
        question: request.question.trim(),
        options,
        ...(options.length > 1 ? { multiSelect: false } : {}),
      },
    ];
    return emit({
      ...createBaseEvent({
        threadId: context.threadId,
        requestId,
        raw,
      }),
      type: "user-input.requested",
      payload: {
        questions,
      },
    });
  };

  const bindPermissionRequests = (
    context: CopilotSessionContext,
    signature: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const pendingHandlers = context.pendingPermissionHandlersBySignature.get(signature);
      const pendingEvents = context.pendingPermissionEventsBySignature.get(signature);
      if (!pendingHandlers?.length || !pendingEvents?.length) {
        return;
      }

      while (pendingHandlers.length > 0 && pendingEvents.length > 0) {
        const handler = pendingHandlers.shift()!;
        const eventData = pendingEvents.shift()!;
        const requestId = eventData.requestId.trim();
        const turnId = resolveTurnIdForEvent(context, {
          providerItemId: toolCallIdFromPermissionRequest(eventData.permissionRequest),
          sdkTurnId: context.activeSdkTurnId,
        });
        context.pendingPermissionBindings.set(requestId, {
          requestId,
          requestType: mapPermissionRequestType(eventData.permissionRequest),
          ...(turnId ? { turnId } : {}),
          permissionRequest: eventData.permissionRequest,
          promptRequest: eventData.promptRequest,
          deferred: handler.deferred,
        });
        if (eventData.resolvedByHook !== true) {
          yield* emitPermissionRequestOpened(
            context,
            context.pendingPermissionBindings.get(requestId)!,
            eventData,
          );
        }
      }

      if (pendingHandlers.length === 0) {
        context.pendingPermissionHandlersBySignature.delete(signature);
      }
      if (pendingEvents.length === 0) {
        context.pendingPermissionEventsBySignature.delete(signature);
      }
    });

  const bindUserInputRequests = (
    context: CopilotSessionContext,
    signature: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const pendingHandlers = context.pendingUserInputHandlersBySignature.get(signature);
      const pendingEvents = context.pendingUserInputEventsBySignature.get(signature);
      if (!pendingHandlers?.length || !pendingEvents?.length) {
        return;
      }

      while (pendingHandlers.length > 0 && pendingEvents.length > 0) {
        const handler = pendingHandlers.shift()!;
        const eventData = pendingEvents.shift()!;
        const requestId = eventData.requestId.trim();
        const binding: PendingUserInputBinding = {
          requestId,
          question: eventData.question.trim(),
          choices: eventData.choices?.map((choice) => choice.trim()).filter(Boolean) ?? [],
          allowFreeform: eventData.allowFreeform ?? true,
          deferred: handler.deferred,
        };
        context.pendingUserInputBindings.set(requestId, binding);
        yield* emitUserInputRequested(context, requestId, binding, {
          id: requestId,
          timestamp: nowIso(),
          parentId: null,
          type: "user_input.requested",
          ephemeral: true,
          data: eventData,
        });
      }

      if (pendingHandlers.length === 0) {
        context.pendingUserInputHandlersBySignature.delete(signature);
      }
      if (pendingEvents.length === 0) {
        context.pendingUserInputEventsBySignature.delete(signature);
      }
    });

  const emitBackgroundTasksPlanSnapshot = (
    context: CopilotSessionContext,
    raw: SessionEvent,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      const turnId = context.activeTurnId ?? latestTurnId(context);
      if (!turnId) {
        return;
      }
      const taskList = yield* copilotSdk.readBackgroundTasks(context);
      if (!taskList) {
        return;
      }
      for (const task of taskList.tasks) {
        const taskId = copilotTaskId(task);
        if (!taskId) {
          continue;
        }
        const description = copilotTaskDescription(task);
        const taskType = copilotTaskType(task);
        const previous = context.copilotTasks.get(taskId);
        const runtimeTaskId = RuntimeTaskId.make(taskId);
        if (!previous) {
          yield* emit({
            ...createBaseEvent({
              threadId: context.threadId,
              turnId,
              raw,
            }),
            type: "task.started",
            payload: {
              taskId: runtimeTaskId,
              description,
              ...(taskType ? { taskType } : {}),
            },
          });
        }
        if (
          (task.status === "running" || task.status === "idle") &&
          (!previous || previous.status !== task.status || previous.description !== description)
        ) {
          yield* emit({
            ...createBaseEvent({
              threadId: context.threadId,
              turnId,
              raw,
            }),
            type: "task.progress",
            payload: {
              taskId: runtimeTaskId,
              description,
              summary: copilotTaskProgressSummary(task.status),
            },
          });
        }
        const completedStatus = completedCopilotTaskStatus(task.status);
        if (completedStatus && previous?.status !== task.status) {
          const summary = copilotTaskCompletionSummary(task);
          yield* emit({
            ...createBaseEvent({
              threadId: context.threadId,
              turnId,
              raw,
            }),
            type: "task.completed",
            payload: {
              taskId: runtimeTaskId,
              status: completedStatus,
              ...(summary ? { summary } : {}),
            },
          });
        }
        context.copilotTasks.set(taskId, {
          description,
          status: task.status,
        });
      }
      const plan = planStepsFromCopilotTasks(taskList.tasks);
      if (plan.length === 0) {
        return;
      }
      yield* emit({
        ...createBaseEvent({
          threadId: context.threadId,
          turnId,
          raw,
        }),
        type: "turn.plan.updated",
        payload: {
          explanation: "Copilot Tasks",
          plan,
        },
      });
    });

  const onPermissionRequest = (
    context: CopilotSessionContext,
    request: PermissionRequest,
  ): Effect.Effect<PermissionRequestResult> =>
    Effect.gen(function* () {
      if (context.stopped) {
        return DENIED_PERMISSION_RESULT;
      }
      if (permissionAutoApprovedByRuntimeMode(context.session.runtimeMode, request)) {
        return APPROVED_PERMISSION_RESULT;
      }

      const signature = permissionSignature(request);
      const deferred = yield* Deferred.make<PermissionRequestResult>();
      const queue = context.pendingPermissionHandlersBySignature.get(signature) ?? [];
      queue.push({
        signature,
        deferred,
      });
      context.pendingPermissionHandlersBySignature.set(signature, queue);
      yield* bindPermissionRequests(context, signature);
      return yield* Deferred.await(deferred);
    });

  const onUserInputRequest = (
    context: CopilotSessionContext,
    request: CopilotUserInputRequest,
  ): Effect.Effect<CopilotUserInputResponse> =>
    Effect.gen(function* () {
      if (context.stopped) {
        return EMPTY_USER_INPUT_RESPONSE;
      }

      const signature = userInputSignature(request);
      const deferred = yield* Deferred.make<CopilotUserInputResponse>();
      const queue = context.pendingUserInputHandlersBySignature.get(signature) ?? [];
      queue.push({
        signature,
        deferred,
      });
      context.pendingUserInputHandlersBySignature.set(signature, queue);
      yield* bindUserInputRequests(context, signature);
      return yield* Deferred.await(deferred);
    });

  const syncSessionMode = (
    context: CopilotSessionContext,
    mode: CopilotMode,
  ): Effect.Effect<void> =>
    copilotSdk.setMode(context, mode).pipe(
      Effect.flatMap(() =>
        emit({
          ...createBaseEvent({
            threadId: context.threadId,
          }),
          type: "session.configured",
          payload: {
            config: {
              mode,
            },
          },
        }),
      ),
      Effect.catch((cause) =>
        emit({
          ...createBaseEvent({
            threadId: context.threadId,
          }),
          type: "runtime.warning",
          payload: {
            message: "Failed to synchronize Copilot mode with the requested runtime mode.",
            detail: cause,
          },
        }),
      ),
    );

  const emitPlanSnapshot = (
    context: CopilotSessionContext,
    raw: SessionEvent,
    fallbackPlan?: string | undefined,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      const turnId = context.activeTurnId ?? latestTurnId(context);
      if (!turnId) {
        return;
      }
      const plan = fallbackPlan
        ? fallbackPlan.trim()
        : (yield* copilotSdk.readPlan(context)).trim();
      if (plan.length === 0) {
        return;
      }
      yield* emit({
        ...createBaseEvent({
          threadId: context.threadId,
          turnId,
          raw,
        }),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: plan,
        },
      });
    });

  const emitSessionReadyEvents = async (input: {
    readonly context: CopilotSessionContext;
    readonly event: SessionStartedEvent | SessionResumedEvent;
    readonly sessionId: string;
    readonly message: string;
    readonly stateReason: string;
  }): Promise<void> => {
    const resumeCursor = toCopilotResumeCursor(input.sessionId);
    updateProviderSession(input.context, {
      status: "ready",
      model: trimOrUndefined(input.event.data.selectedModel) ?? input.context.session.model,
      ...(input.event.data.context?.cwd ? { cwd: input.event.data.context.cwd } : {}),
      resumeCursor,
    });
    await emitAsync({
      ...createBaseEvent({
        threadId: input.context.threadId,
        raw: input.event,
      }),
      type: "session.started",
      payload: {
        message: input.message,
        resume: resumeCursor,
      },
    });
    await emitAsync({
      ...createBaseEvent({
        threadId: input.context.threadId,
        raw: input.event,
      }),
      type: "session.configured",
      payload: {
        config: {
          model: input.event.data.selectedModel ?? null,
          reasoningEffort: input.event.data.reasoningEffort ?? null,
          cwd: input.event.data.context?.cwd ?? input.context.cwd,
        },
      },
    });
    await emitAsync({
      ...createBaseEvent({
        threadId: input.context.threadId,
        raw: input.event,
      }),
      type: "session.state.changed",
      payload: {
        state: "ready",
        reason: input.stateReason,
      },
    });
    await emitAsync({
      ...createBaseEvent({
        threadId: input.context.threadId,
        raw: input.event,
      }),
      type: "thread.started",
      payload: {
        providerThreadId: input.sessionId,
      },
    });
  };

  const handleSdkEvent = async (
    context: CopilotSessionContext,
    event: SessionEvent,
  ): Promise<void> => {
    switch (event.type) {
      case "session.start": {
        await emitSessionReadyEvents({
          context,
          event,
          sessionId: event.data.sessionId,
          message: "Copilot session started.",
          stateReason: "Copilot session ready",
        });
        return;
      }
      case "session.resume": {
        await emitSessionReadyEvents({
          context,
          event,
          sessionId: context.sdkSession.sessionId,
          message: "Copilot session resumed.",
          stateReason: "Copilot session resumed",
        });
        return;
      }
      case "session.error": {
        const message = trimOrUndefined(event.data.message) ?? "Copilot session failed.";
        const activeTurnId = context.activeTurnId;
        updateProviderSession(context, {
          status: "error",
          lastError: message,
          activeTurnId: undefined,
        });
        if (activeTurnId) {
          await emitTurnCompleted(context, activeTurnId, "failed", {
            errorMessage: message,
            raw: event,
          });
        }
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            raw: event,
          }),
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error",
            detail: event.data,
          },
        });
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            raw: event,
          }),
          type: "session.state.changed",
          payload: {
            state: "error",
            reason: message,
            detail: event.data,
          },
        });
        return;
      }
      case "session.idle": {
        if (context.activeTurnId) {
          const turnId = context.activeTurnId;
          if (!event.data.aborted) {
            await emitPendingTaskCompletionAsAssistantMessage(context, turnId, event);
          }
          await emitTurnCompleted(context, turnId, event.data.aborted ? "cancelled" : "completed", {
            raw: event,
            stopReason: event.data.aborted ? "aborted" : null,
          });
        }
        const idleStatus = context.stopped ? "closed" : readyStatusAfterTurnCompletion(context);
        const idleState = context.stopped ? "stopped" : readyStatusAfterTurnCompletion(context);
        updateProviderSession(context, {
          status: idleStatus,
          activeTurnId: undefined,
        });
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            raw: event,
          }),
          type: "session.state.changed",
          payload: {
            state: idleState,
            reason: event.data.aborted ? "Copilot turn aborted." : "Copilot idle.",
          },
        });
        return;
      }
      case "session.title_changed": {
        const title = trimOrUndefined(event.data.title);
        if (!title) {
          return;
        }
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            raw: event,
          }),
          type: "thread.metadata.updated",
          payload: {
            name: title,
          },
        });
        return;
      }
      case "session.warning": {
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            raw: event,
          }),
          type: "runtime.warning",
          payload: {
            message: trimOrUndefined(event.data.message) ?? "",
            detail: event.data,
          },
        });
        return;
      }
      case "session.model_change": {
        updateProviderSession(context, {
          model: trimOrUndefined(event.data.newModel) ?? context.session.model,
        });
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            raw: event,
          }),
          type: "session.configured",
          payload: {
            config: {
              model: event.data.newModel,
              reasoningEffort: event.data.reasoningEffort ?? null,
              previousModel: event.data.previousModel ?? null,
            },
          },
        });
        return;
      }
      case "session.mode_changed": {
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            raw: event,
          }),
          type: "session.configured",
          payload: {
            config: {
              mode: event.data.newMode,
              previousMode: event.data.previousMode,
            },
          },
        });
        return;
      }
      case "session.plan_changed": {
        if (event.data.operation === "delete") {
          return;
        }
        await runWithContext(emitPlanSnapshot(context, event));
        return;
      }
      case "session.usage_info": {
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId: context.activeTurnId,
            raw: event,
          }),
          type: "thread.token-usage.updated",
          payload: {
            usage: usageSnapshotFromUsageInfo(event),
          },
        });
        return;
      }
      case "session.background_tasks_changed": {
        await runWithContext(emitBackgroundTasksPlanSnapshot(context, event));
        return;
      }
      case "assistant.turn_start": {
        const turnId = resolveTurnIdForSdkTurn(context, event.data.turnId, {
          timestamp: event.timestamp,
          agentId: event.agentId,
        });
        if (!turnId) {
          return;
        }
        updateProviderSession(context, {
          status: "running",
          activeTurnId: turnId,
        });
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId,
            raw: event,
          }),
          type: "session.state.changed",
          payload: {
            state: "running",
            reason: "Copilot turn started",
          },
        });
        return;
      }
      case "assistant.reasoning_delta": {
        const turnId = resolveTurnIdForEvent(context, {
          sdkTurnId: context.activeSdkTurnId,
          sdkEventTimestamp: event.timestamp,
          agentId: event.agentId,
          providerItemId: event.data.reasoningId,
        });
        if (!turnId) {
          return;
        }
        const itemId = `copilot-reasoning-${event.data.reasoningId}`;
        context.turnIdByProviderItemId.set(event.data.reasoningId, turnId);
        await emitTextDelta({
          context,
          turnId,
          itemId,
          itemType: "reasoning",
          streamKind: "reasoning_text",
          nextText: (context.emittedTextByItemId.get(itemId) ?? "") + event.data.deltaContent,
          raw: event,
        });
        return;
      }
      case "assistant.reasoning": {
        const turnId = resolveTurnIdForEvent(context, {
          sdkTurnId: context.activeSdkTurnId,
          sdkEventTimestamp: event.timestamp,
          agentId: event.agentId,
          providerItemId: event.data.reasoningId,
        });
        if (!turnId) {
          return;
        }
        const itemId = `copilot-reasoning-${event.data.reasoningId}`;
        context.turnIdByProviderItemId.set(event.data.reasoningId, turnId);
        await emitTextDelta({
          context,
          turnId,
          itemId,
          itemType: "reasoning",
          streamKind: "reasoning_text",
          nextText: event.data.content,
          raw: event,
        });
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId,
            itemId,
            raw: event,
          }),
          type: "item.completed",
          payload: {
            itemType: "reasoning",
            status: "completed",
          },
        });
        appendTurnItem(context, turnId, {
          type: "reasoning",
          reasoningId: event.data.reasoningId,
          content: event.data.content,
        });
        return;
      }
      case "assistant.message_delta": {
        const turnId = resolveTurnIdForEvent(context, {
          sdkTurnId: context.activeSdkTurnId,
          sdkEventTimestamp: event.timestamp,
          agentId: event.agentId,
          providerItemId: event.data.messageId,
          parentProviderItemId: event.data.parentToolCallId,
        });
        if (!turnId) {
          return;
        }
        const itemId = `copilot-message-${event.data.messageId}`;
        context.turnIdByProviderItemId.set(event.data.messageId, turnId);
        context.assistantItemIdByTurnId.set(turnId, itemId);
        await emitTextDelta({
          context,
          turnId,
          itemId,
          itemType: "assistant_message",
          streamKind: "assistant_text",
          nextText: (context.emittedTextByItemId.get(itemId) ?? "") + event.data.deltaContent,
          raw: event,
        });
        return;
      }
      case "assistant.message": {
        const turnId = resolveTurnIdForEvent(context, {
          sdkTurnId: event.data.turnId ?? context.activeSdkTurnId,
          sdkEventTimestamp: event.timestamp,
          agentId: event.agentId,
          providerItemId: event.data.messageId,
          parentProviderItemId: event.data.parentToolCallId,
        });
        if (!turnId) {
          return;
        }
        const itemId = `copilot-message-${event.data.messageId}`;
        context.turnIdByProviderItemId.set(event.data.messageId, turnId);
        context.assistantItemIdByTurnId.set(turnId, itemId);
        await emitTextDelta({
          context,
          turnId,
          itemId,
          itemType: "assistant_message",
          streamKind: "assistant_text",
          nextText: event.data.content,
          raw: event,
        });
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId,
            itemId,
            raw: event,
          }),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
          },
        });
        if (event.data.reasoningText?.trim()) {
          const reasoningItemId = `copilot-message-reasoning-${event.data.messageId}`;
          await emitTextDelta({
            context,
            turnId,
            itemId: reasoningItemId,
            itemType: "reasoning",
            streamKind: "reasoning_text",
            nextText: event.data.reasoningText,
            raw: event,
          });
          await emitAsync({
            ...createBaseEvent({
              threadId: context.threadId,
              turnId,
              itemId: reasoningItemId,
              raw: event,
            }),
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: "completed",
            },
          });
        }
        appendTurnItem(context, turnId, {
          type: "assistant_message",
          messageId: event.data.messageId,
          content: event.data.content,
        });
        return;
      }
      case "assistant.turn_end": {
        const sdkTurnKey = sdkTurnMappingKey(event.agentId, event.data.turnId);
        const turnId = context.sdkTurnIdsToTurnIds.get(sdkTurnKey);
        if (!turnId) {
          return;
        }
        if (context.activeSdkTurnKey === sdkTurnKey) {
          context.activeSdkTurnId = undefined;
          context.activeSdkTurnKey = undefined;
        }
        return;
      }
      case "assistant.usage": {
        const turnId = resolveTurnIdForEvent(context, {
          parentProviderItemId: event.data.parentToolCallId,
          sdkTurnId: context.activeSdkTurnId,
          sdkEventTimestamp: event.timestamp,
          agentId: event.agentId,
        });
        if (!turnId) {
          return;
        }
        const usage = usageSnapshotFromAssistantUsage(event);
        context.turnUsageByTurnId.set(turnId, usage);
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId,
            raw: event,
          }),
          type: "thread.token-usage.updated",
          payload: {
            usage,
          },
        });
        return;
      }
      case "abort": {
        const turnId = context.activeTurnId;
        if (!turnId) {
          return;
        }
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId,
            raw: event,
          }),
          type: "turn.aborted",
          payload: {
            reason: event.data.reason,
          },
        });
        await emitTurnCompleted(context, turnId, "cancelled", {
          raw: event,
          stopReason: "aborted",
        });
        return;
      }
      case "tool.execution_start": {
        const turnId = resolveTurnIdForEvent(context, {
          providerItemId: event.data.toolCallId,
          parentProviderItemId: event.data.parentToolCallId,
          sdkTurnId: event.data.turnId ?? context.activeSdkTurnId,
          sdkEventTimestamp: event.timestamp,
          agentId: event.agentId,
        });
        if (!turnId) {
          return;
        }
        const todoPlan =
          isTodoTool(event.data.toolName) && isStringRecord(event.data.arguments)
            ? extractPlanStepsFromTodoInput(event.data.arguments)
            : undefined;
        if (todoPlan && todoPlan.length > 0) {
          await emitAsync({
            ...createBaseEvent({
              threadId: context.threadId,
              turnId,
              raw: event,
            }),
            type: "turn.plan.updated",
            payload: {
              explanation: "Copilot Todos",
              plan: todoPlan,
            },
          });
        }
        const itemId = `copilot-tool-${event.data.toolCallId}`;
        const itemType = toolItemType(
          event.data.toolName,
          event.data.mcpServerName,
          event.data.arguments,
        );
        const command = commandFromToolArguments(event.data.arguments);
        const toolMeta: ToolMeta = {
          toolName: event.data.toolName,
          itemType,
          ...(command ? { command } : {}),
        };
        context.toolMetaById.set(event.data.toolCallId, {
          ...toolMeta,
        });
        context.turnIdByProviderItemId.set(event.data.toolCallId, turnId);
        if (isTaskCompleteTool(event.data.toolName)) {
          return;
        }
        context.startedItemIds.add(itemId);
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId,
            itemId,
            raw: event,
          }),
          type: "item.started",
          payload: {
            itemType,
            status: "inProgress",
            title: toolLifecycleTitle(toolMeta),
            ...(toolMeta.itemType === "command_execution" && toolMeta.command
              ? { detail: toolMeta.command }
              : {}),
            data: toolLifecycleData({
              toolCallId: event.data.toolCallId,
              toolMeta,
              ...(event.data.arguments ? { arguments: event.data.arguments } : {}),
            }),
          },
        });
        return;
      }
      case "tool.execution_partial_result": {
        const turnId = resolveTurnIdForEvent(context, {
          providerItemId: event.data.toolCallId,
          sdkTurnId: context.activeSdkTurnId,
          sdkEventTimestamp: event.timestamp,
          agentId: event.agentId,
          allowActiveFallback: false,
        });
        if (!turnId) {
          return;
        }
        const itemId = `copilot-tool-${event.data.toolCallId}`;
        const toolMeta = context.toolMetaById.get(event.data.toolCallId);
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId,
            itemId,
            raw: event,
          }),
          type: "content.delta",
          payload: {
            streamKind: toolStreamKind(toolMeta?.itemType),
            delta: event.data.partialOutput,
          },
        });
        return;
      }
      case "tool.execution_progress": {
        const turnId = resolveTurnIdForEvent(context, {
          providerItemId: event.data.toolCallId,
          sdkTurnId: context.activeSdkTurnId,
          sdkEventTimestamp: event.timestamp,
          agentId: event.agentId,
          allowActiveFallback: false,
        });
        const summary = trimOrUndefined(event.data.progressMessage);
        if (!turnId || !summary) {
          return;
        }
        const toolMeta = context.toolMetaById.get(event.data.toolCallId);
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId,
            itemId: `copilot-tool-${event.data.toolCallId}`,
            raw: event,
          }),
          type: "tool.progress",
          payload: {
            toolUseId: event.data.toolCallId,
            ...(toolMeta ? { toolName: toolMeta.toolName } : {}),
            summary,
          },
        });
        return;
      }
      case "tool.execution_complete": {
        const turnId = resolveTurnIdForEvent(context, {
          providerItemId: event.data.toolCallId,
          parentProviderItemId: event.data.parentToolCallId,
          sdkTurnId: event.data.turnId ?? context.activeSdkTurnId,
          sdkEventTimestamp: event.timestamp,
          agentId: event.agentId,
        });
        if (!turnId) {
          return;
        }
        const itemId = `copilot-tool-${event.data.toolCallId}`;
        const eventData = stringRecord(event.data);
        const eventToolName = trimOrUndefined(
          typeof eventData?.toolName === "string" ? eventData.toolName : undefined,
        );
        const fallbackToolMeta: ToolMeta | undefined = eventToolName
          ? {
              toolName: eventToolName,
              itemType: toolItemType(eventToolName, undefined, eventData?.arguments),
            }
          : undefined;
        const toolMeta = context.toolMetaById.get(event.data.toolCallId) ?? fallbackToolMeta;
        const rawDetail =
          trimOrUndefined(event.data.result?.detailedContent) ??
          trimOrUndefined(event.data.result?.content) ??
          trimOrUndefined(event.data.error?.message);
        const detail = normalizedToolCompletionDetail(toolMeta, rawDetail);
        if (isTaskCompleteTool(toolMeta?.toolName)) {
          if (event.data.success && detail) {
            context.pendingTaskCompletionTextByTurnId.set(turnId, detail);
          }
          return;
        }
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            turnId,
            itemId,
            raw: event,
          }),
          type: "item.completed",
          payload: {
            itemType: toolMeta?.itemType ?? "dynamic_tool_call",
            status: event.data.success ? "completed" : "failed",
            title: toolLifecycleTitle(toolMeta),
            ...(detail ? { detail } : {}),
            data: toolLifecycleData({
              toolCallId: event.data.toolCallId,
              toolMeta,
              ...(event.data.result !== undefined ? { result: event.data.result } : {}),
              ...(event.data.error ? { error: event.data.error } : {}),
              ...(event.data.toolTelemetry ? { toolTelemetry: event.data.toolTelemetry } : {}),
            }),
          },
        });
        const diffText = event.data.success
          ? completedToolDiffText(toolMeta, rawDetail)
          : undefined;
        if (diffText) {
          await emitTurnDiffUpdated({
            context,
            turnId,
            diffText,
            raw: event,
          });
        }
        const toolItem: CopilotToolExecutionItem = {
          type: "tool_execution",
          toolCallId: event.data.toolCallId,
          ...(toolMeta?.toolName ? { toolName: toolMeta.toolName } : {}),
          ...(toolMeta?.itemType ? { itemType: toolMeta.itemType } : {}),
          success: event.data.success,
          ...(detail ? { detail } : {}),
        };
        appendTurnItem(context, turnId, toolItem);
        return;
      }
      case "permission.requested": {
        if (event.data.resolvedByHook === true) {
          return;
        }
        const signature = permissionSignature(event.data.permissionRequest);
        const queue = context.pendingPermissionEventsBySignature.get(signature) ?? [];
        queue.push(event.data);
        context.pendingPermissionEventsBySignature.set(signature, queue);
        await runWithContext(bindPermissionRequests(context, signature));
        return;
      }
      case "permission.completed": {
        const binding = context.pendingPermissionBindings.get(event.data.requestId);
        if (!binding) {
          return;
        }
        context.pendingPermissionBindings.delete(event.data.requestId);
        if (binding.permissionRequest.kind === "write") {
          const turnId =
            binding.turnId ??
            resolveTurnIdForEvent(context, {
              providerItemId: toolCallIdFromPermissionRequest(binding.permissionRequest),
              sdkTurnId: context.activeSdkTurnId,
            });
          if (turnId && isPermissionCompletionApproved(event.data.result)) {
            const writeDiff = trimOrUndefined(binding.permissionRequest.diff);
            if (writeDiff) {
              await emitTurnDiffUpdated({
                context,
                turnId,
                diffText: writeDiff,
                raw: event,
              });
            }
          }
        }
        await runWithContext(
          emitPermissionRequestResolved(
            context,
            binding,
            event.data.result.kind,
            event.data.result,
            event,
          ),
        );
        return;
      }
      case "user_input.requested": {
        const signature = userInputSignature({
          question: event.data.question,
          ...(event.data.choices ? { choices: event.data.choices } : {}),
          ...(event.data.allowFreeform !== undefined
            ? { allowFreeform: event.data.allowFreeform }
            : {}),
        });
        const queue = context.pendingUserInputEventsBySignature.get(signature) ?? [];
        queue.push(event.data);
        context.pendingUserInputEventsBySignature.set(signature, queue);
        await runWithContext(bindUserInputRequests(context, signature));
        return;
      }
      case "user_input.completed": {
        const binding = context.pendingUserInputBindings.get(event.data.requestId);
        if (!binding) {
          return;
        }
        context.pendingUserInputBindings.delete(event.data.requestId);
        await emitAsync({
          ...createBaseEvent({
            threadId: context.threadId,
            requestId: binding.requestId,
            raw: event,
          }),
          type: "user-input.resolved",
          payload: {
            answers: answersFromCompletedUserInput(event.data),
          },
        });
        return;
      }
      case "exit_plan_mode.requested": {
        await runWithContext(emitPlanSnapshot(context, event, event.data.planContent));
        return;
      }
      case "exit_plan_mode.completed":
      default:
        return;
    }
  };

  const startSession: CopilotAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* validationError(
          "startSession",
          `Expected provider '${PROVIDER}', received '${input.provider}'.`,
        );
      }
      if (input.providerInstanceId !== undefined && input.providerInstanceId !== boundInstanceId) {
        return yield* validationError(
          "startSession",
          `Expected provider instance '${boundInstanceId}', received '${input.providerInstanceId}'.`,
        );
      }

      if (sessions.has(input.threadId)) {
        yield* stopSessionInternal(input.threadId);
      }

      if (!settings.enabled) {
        return yield* validationError("startSession", "Copilot is disabled in server settings.");
      }

      const cwd = path.resolve(input.cwd ?? serverConfig.cwd);
      const modelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const reasoningEffort = getModelSelectionStringOptionValue(
        modelSelection,
        "reasoningEffort",
      ) as CopilotReasoningEffort | undefined;
      const contextTier = getModelSelectionStringOptionValue(modelSelection, "contextTier") as
        | CopilotContextTier
        | undefined;
      let context: CopilotSessionContext | undefined;
      const earlyEvents: Array<SessionEvent> = [];
      const onEvent: SessionConfig["onEvent"] = (event) => {
        if (!context) {
          earlyEvents.push(event);
          return;
        }
        enqueueSdkEvent(context, event);
      };
      const onSessionPermissionRequest = (_request: PermissionRequest) => {
        return runWithContext(
          context
            ? onPermissionRequest(context, _request)
            : Effect.succeed(
                permissionAutoApprovedByRuntimeMode(input.runtimeMode, _request)
                  ? APPROVED_PERMISSION_RESULT
                  : DENIED_PERMISSION_RESULT,
              ),
        );
      };
      const onSessionUserInputRequest = (_request: CopilotUserInputRequest) => {
        return runWithContext(
          context
            ? onUserInputRequest(context, _request)
            : Effect.succeed(EMPTY_USER_INPUT_RESPONSE),
        );
      };

      const platform = yield* HostProcessPlatform;
      const client = yield* createCopilotClient({
        settings,
        cwd,
        ...(options?.baseDirectory ? { baseDirectory: options.baseDirectory } : {}),
        ...(options?.environment ? { env: options.environment } : {}),
        platform,
        logLevel: "error",
      }).pipe(
        Effect.mapError((cause) =>
          processError(
            input.threadId,
            detailFromCause(cause, "Failed to configure Copilot client."),
            cause,
          ),
        ),
      );

      const baseSessionConfig = {
        clientName: "t3-code",
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(contextTier ? { contextTier } : {}),
        workingDirectory: cwd,
        streaming: true,
        enableConfigDiscovery: true,
        onEvent,
      } satisfies Pick<
        SessionConfig,
        | "clientName"
        | "model"
        | "reasoningEffort"
        | "contextTier"
        | "workingDirectory"
        | "streaming"
        | "enableConfigDiscovery"
        | "onEvent"
      >;

      const createFreshSdkSession = () =>
        copilotSdk.createSession(input.threadId, client, {
          ...baseSessionConfig,
          sessionId: input.threadId,
          onPermissionRequest: onSessionPermissionRequest,
          onUserInputRequest: onSessionUserInputRequest,
        });

      const sdkSession = yield* Effect.gen(function* () {
        yield* copilotSdk.startClient(input.threadId, client);
        const resume = parseCopilotResumeCursor(input.resumeCursor);
        if (resume) {
          return yield* copilotSdk
            .resumeSession(input.threadId, client, resume.sessionId, {
              ...baseSessionConfig,
              onPermissionRequest: onSessionPermissionRequest,
              onUserInputRequest: onSessionUserInputRequest,
            })
            .pipe(
              Effect.catch((error) =>
                isCopilotSessionNotFoundError(error, resume.sessionId)
                  ? Effect.logInfo("copilot resume cursor is stale; starting a fresh session", {
                      threadId: input.threadId,
                      sessionId: resume.sessionId,
                    }).pipe(Effect.andThen(createFreshSdkSession()))
                  : Effect.fail(error),
              ),
            );
        }
        return yield* createFreshSdkSession();
      }).pipe(
        Effect.tapError(() => copilotSdk.stopClient(input.threadId, client).pipe(Effect.ignore)),
      );

      context = {
        threadId: input.threadId,
        client,
        sdkSession,
        cwd,
        session: {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          threadId: input.threadId,
          resumeCursor: toCopilotResumeCursor(sdkSession.sessionId),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        turns: [],
        queuedTurnIds: [],
        turnQueuedAtMsByTurnId: new Map(),
        sdkTurnIdsToTurnIds: new Map(),
        completedTurnIds: new Set(),
        turnUsageByTurnId: new Map(),
        pendingPermissionHandlersBySignature: new Map(),
        pendingPermissionEventsBySignature: new Map(),
        pendingPermissionBindings: new Map(),
        pendingUserInputHandlersBySignature: new Map(),
        pendingUserInputEventsBySignature: new Map(),
        pendingUserInputBindings: new Map(),
        toolMetaById: new Map(),
        turnIdByProviderItemId: new Map(),
        emittedTextByItemId: new Map(),
        assistantItemIdByTurnId: new Map(),
        pendingTaskCompletionTextByTurnId: new Map(),
        emittedTurnDiffByTurnId: new Map(),
        copilotTasks: new Map(),
        turnIdsWithAssistantText: new Set(),
        startedItemIds: new Set(),
        activeTurnId: undefined,
        activeSdkTurnId: undefined,
        activeSdkTurnKey: undefined,
        eventChain: Promise.resolve(),
        stopped: false,
      };
      sessions.set(input.threadId, context);

      yield* syncSessionMode(
        context,
        requestedCopilotMode({
          runtimeMode: input.runtimeMode,
        }),
      );

      for (const event of earlyEvents) {
        enqueueSdkEvent(context, event);
      }
      yield* Effect.promise(() => context.eventChain).pipe(
        Effect.mapError((cause) =>
          processError(
            input.threadId,
            detailFromCause(cause, "Failed to process Copilot startup events."),
            cause,
          ),
        ),
      );
      updateProviderSession(context, {
        status: context.session.status === "connecting" ? "ready" : context.session.status,
      });

      return context.session;
    },
  );

  const sendTurn: CopilotAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSessionContext(sessions, input.threadId);

    const text = input.input?.trim();
    const attachments = yield* Effect.forEach(input.attachments ?? [], (attachment) => {
      const filePath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!filePath) {
        return Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.send",
            detail: `Invalid attachment id '${attachment.id}'.`,
          }),
        );
      }
      return Effect.succeed({
        type: "file" as const,
        path: filePath,
        displayName: attachment.name,
      });
    });
    if ((!text || text.length === 0) && attachments.length === 0) {
      return yield* validationError(
        "sendTurn",
        "Copilot turns require text input or at least one attachment.",
      );
    }

    const turnId = TurnId.make(`copilot-turn-${randomUUID()}`);
    const modelSelection =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
    const rawReasoningEffort = getModelSelectionStringOptionValue(
      modelSelection,
      "reasoningEffort",
    );
    const reasoningEffort = rawReasoningEffort as CopilotReasoningEffort | undefined;
    const rawContextTier = getModelSelectionStringOptionValue(modelSelection, "contextTier");
    const contextTier = rawContextTier as CopilotContextTier | undefined;
    if (modelSelection?.model) {
      yield* copilotSdk.setModel(context, modelSelection.model, reasoningEffort, contextTier);
      updateProviderSession(context, {
        model: modelSelection.model,
        ...(reasoningEffort || contextTier ? { status: "ready" } : {}),
      });
    }

    const mode = requestedCopilotMode({
      runtimeMode: context.session.runtimeMode,
      interactionMode: input.interactionMode,
    });
    yield* syncSessionMode(context, mode);

    const queuedAt = yield* DateTime.now;
    ensureTurnSnapshot(context, turnId);
    context.turnQueuedAtMsByTurnId.set(turnId, epochMsFromIso(DateTime.formatIso(queuedAt)) ?? 0);
    context.queuedTurnIds.push(turnId);
    const shouldPromoteQueuedTurn =
      context.activeTurnId === undefined && context.activeSdkTurnKey === undefined;
    if (shouldPromoteQueuedTurn) {
      context.activeTurnId = turnId;
    }
    updateProviderSession(context, {
      status: "running",
      ...(shouldPromoteQueuedTurn ? { activeTurnId: turnId } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
    });

    yield* emit({
      ...createBaseEvent({
        threadId: input.threadId,
        turnId,
      }),
      type: "turn.started",
      payload: {
        model: modelSelection?.model ?? context.session.model,
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        ...(contextTier ? { contextTier } : {}),
      },
    });

    const messageOptions: MessageOptions = {
      prompt: text ?? "",
      ...(attachments.length > 0 ? { attachments } : {}),
      mode: "enqueue",
    };

    const providerMessageId = yield* copilotSdk.send(context, messageOptions).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const queueIndex = context.queuedTurnIds.indexOf(turnId);
          if (queueIndex >= 0) {
            context.queuedTurnIds.splice(queueIndex, 1);
          }
          context.turnQueuedAtMsByTurnId.delete(turnId);
          if (context.activeTurnId === turnId) {
            context.activeTurnId = undefined;
          }
          updateProviderSession(context, {
            status: context.activeTurnId ? "running" : readyStatusAfterTurnCompletion(context),
            ...(context.activeTurnId
              ? { activeTurnId: context.activeTurnId }
              : { activeTurnId: undefined }),
          });
          yield* emit({
            ...createBaseEvent({
              threadId: input.threadId,
              turnId,
            }),
            type: "turn.aborted",
            payload: {
              reason: error.detail,
            },
          });
          yield* Effect.tryPromise({
            try: () =>
              emitTurnCompleted(context, turnId, "failed", {
                errorMessage: error.detail,
              }),
            catch: (cause) =>
              processError(
                input.threadId,
                detailFromCause(cause, "Failed to emit Copilot turn completion."),
                cause,
              ),
          });
          return yield* error;
        }),
      ),
    );
    if (trimOrUndefined(providerMessageId)) {
      context.turnIdByProviderItemId.set(providerMessageId, turnId);
    }

    return {
      threadId: input.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: CopilotAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSessionContext(sessions, threadId);

      yield* copilotSdk.abort(context);
    },
  );

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSessionContext(sessions, threadId);

      const binding = context.pendingPermissionBindings.get(requestId);
      if (!binding) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      const approvalDecision = sessionApprovalDecisionFromPermissionRequest(
        binding.permissionRequest,
        binding.promptRequest,
      );
      const result: PermissionRequestResult =
        decision === "accept"
          ? APPROVED_PERMISSION_RESULT
          : decision === "acceptForSession" && approvalDecision
            ? approvalDecision
            : decision === "acceptForSession"
              ? APPROVED_PERMISSION_RESULT
              : DENIED_PERMISSION_RESULT;
      if (
        binding.permissionRequest.kind === "write" &&
        (decision === "accept" || decision === "acceptForSession")
      ) {
        const turnId =
          binding.turnId ??
          resolveTurnIdForEvent(context, {
            providerItemId: toolCallIdFromPermissionRequest(binding.permissionRequest),
            sdkTurnId: context.activeSdkTurnId,
          });
        const writeDiff = trimOrUndefined(binding.permissionRequest.diff);
        if (turnId && writeDiff) {
          yield* Effect.tryPromise({
            try: () =>
              emitTurnDiffUpdated({
                context,
                turnId,
                diffText: writeDiff,
              }),
            catch: (cause) =>
              processError(
                threadId,
                detailFromCause(cause, "Failed to emit Copilot write diff update."),
                cause,
              ),
          });
        }
      }
      yield* emitPermissionRequestResolved(context, binding, decision, result);
      context.pendingPermissionBindings.delete(requestId);
      yield* Deferred.succeed(binding.deferred, result);
    },
  );

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSessionContext(sessions, threadId);

    const binding = context.pendingUserInputBindings.get(requestId);
    if (!binding) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user_input.reply",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    const response = answerFromUserInput(binding, answers);
    yield* emit({
      ...createBaseEvent({
        threadId: context.threadId,
        requestId: binding.requestId,
      }),
      type: "user-input.resolved",
      payload: {
        answers: {
          answer: response.answer,
        },
      },
    });
    context.pendingUserInputBindings.delete(requestId);
    yield* Deferred.succeed(binding.deferred, response);
  });

  const stopSessionInternal = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return;
      }
      if (context.stopped) {
        sessions.delete(threadId);
        return;
      }

      context.stopped = true;
      yield* Effect.promise(() => context.eventChain);
      yield* settlePendingPermissionHandlers(context);
      yield* settlePendingUserInputs(context);
      yield* copilotSdk.disconnect(context).pipe(Effect.ignore);
      yield* copilotSdk.stopClient(threadId, context.client).pipe(Effect.ignore);

      updateProviderSession(context, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emit({
        ...createBaseEvent({
          threadId,
        }),
        type: "session.state.changed",
        payload: {
          state: "stopped",
          reason: "Copilot session stopped.",
        },
      });
      yield* emit({
        ...createBaseEvent({
          threadId,
        }),
        type: "session.exited",
        payload: {
          reason: "Copilot session stopped.",
          exitKind: "graceful",
        },
      });
      sessions.delete(threadId);
    });

  const stopSession: CopilotAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      if (!sessions.has(threadId)) {
        return yield* sessionNotFoundError(threadId);
      }
      yield* stopSessionInternal(threadId);
    },
  );

  const listSessions: CopilotAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => context.session));

  const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: CopilotAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSessionContext(sessions, threadId);
      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    },
  );

  const rollbackThread: CopilotAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, _numTurns) {
      if (!sessions.has(threadId)) {
        return yield* sessionNotFoundError(threadId);
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread.rollback",
        detail: "Copilot SDK does not expose thread rollback.",
      });
    },
  );

  const stopAll: CopilotAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      yield* Effect.forEach(Array.from(sessions.keys()), stopSessionInternal, {
        concurrency: "unbounded",
        discard: true,
      });
      if (managedNativeEventLogger) {
        yield* managedNativeEventLogger.close();
      }
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies CopilotAdapterShape;
});
