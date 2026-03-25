import { randomUUID } from "node:crypto";

import {
  type CopilotModelSelection,
  type CodexReasoningEffort,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  CopilotClient,
  type CopilotClientOptions,
  type ModelInfo,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
} from "@github/copilot-sdk";
import { Effect, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  assistantUsageFields,
  beginCopilotTurn,
  clearTurnTracking,
  completionTurnRefs,
  isCopilotTurnTerminalEvent,
  markTurnAwaitingCompletion,
  recordTurnUsage,
  type CopilotTurnTrackingState,
} from "./copilotTurnTracking.ts";
import { normalizeCopilotCliPathOverride, resolveBundledCopilotCliPath } from "./copilotCliPath.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = "copilot" as const;
const USER_INPUT_QUESTION_ID = "answer";
const USER_INPUT_QUESTION_HEADER = "Question";

export interface CopilotAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotClientHandle;
}

interface PendingApprovalRequest {
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: PermissionRequestResult) => void;
}

interface CopilotUserInputRequest {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
}

interface CopilotUserInputResponse {
  readonly answer: string;
  readonly wasFreeform: boolean;
}

interface PendingUserInputRequest {
  readonly request: CopilotUserInputRequest;
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: CopilotUserInputResponse) => void;
}

interface ActiveCopilotSession extends CopilotTurnTrackingState {
  readonly client: CopilotClientHandle;
  session: CopilotSessionHandle;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  cwd: string | undefined;
  configDir: string | undefined;
  model: string | undefined;
  reasoningEffort: CodexReasoningEffort | undefined;
  interactionMode: "default" | "plan" | undefined;
  updatedAt: string;
  lastError: string | undefined;
  toolItemTypesByCallId: Map<string, ToolLifecycleItemType>;
  toolTitlesByCallId: Map<string, string>;
  toolDetailsByCallId: Map<string, string>;
  pendingApprovalResolvers: Map<string, PendingApprovalRequest>;
  pendingUserInputResolvers: Map<string, PendingUserInputRequest>;
  unsubscribe: () => void;
}

interface CopilotSessionHandle {
  readonly sessionId: string;
  readonly rpc: {
    readonly model: {
      switchTo(input: { modelId: string; reasoningEffort?: string }): Promise<{
        modelId?: string;
      }>;
    };
    readonly mode: {
      set(input: { mode: "interactive" | "plan" | "autopilot" }): Promise<{
        mode: "interactive" | "plan" | "autopilot";
      }>;
    };
    readonly plan: {
      read(): Promise<{
        exists: boolean;
        content: string | null;
        path: string | null;
      }>;
    };
  };
  disconnect?(): Promise<void>;
  destroy(): Promise<void>;
  on(handler: (event: SessionEvent) => void): () => void;
  send(options: { prompt: string; attachments?: unknown; mode?: string }): Promise<string>;
  abort(): Promise<void>;
  getMessages(): Promise<SessionEvent[]>;
}

interface CopilotClientHandle {
  start(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  createSession(
    config: Parameters<CopilotClient["createSession"]>[0],
  ): Promise<CopilotSessionHandle>;
  resumeSession(
    sessionId: string,
    config: Parameters<CopilotClient["resumeSession"]>[1],
  ): Promise<CopilotSessionHandle>;
  stop(): Promise<Error[]>;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function makeEventId(prefix: string) {
  return EventId.makeUnsafe(`${prefix}-${randomUUID()}`);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return TurnId.makeUnsafe(value);
}

function toRuntimeItemId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return RuntimeItemId.makeUnsafe(value);
}

function toProviderItemId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return ProviderItemId.makeUnsafe(value);
}

function toRuntimeRequestId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return RuntimeRequestId.makeUnsafe(value);
}

function toRuntimeTaskId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return RuntimeTaskId.makeUnsafe(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function makeCopilotSessionId(threadId: ThreadId): string {
  return `t3code-copilot-${threadId}`;
}

async function closeCopilotSession(session: CopilotSessionHandle): Promise<void> {
  if (typeof session.disconnect === "function") {
    await session.disconnect();
    return;
  }
  await session.destroy();
}

function mapSupportedModelsById(models: ReadonlyArray<ModelInfo>) {
  return new Map(models.map((model) => [model.id, model]));
}

function getCopilotModelSelection(
  input: Pick<ProviderSessionStartInput | ProviderSendTurnInput, "modelSelection">,
): CopilotModelSelection | undefined {
  return input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
}

function getCopilotReasoningEffort(
  modelSelection: CopilotModelSelection | undefined,
): CodexReasoningEffort | undefined {
  return modelSelection?.options?.reasoningEffort;
}

function normalizeCopilotSessionTokenUsage(
  usage: Extract<SessionEvent, { type: "session.usage_info" }>["data"],
): ThreadTokenUsageSnapshot | undefined {
  if (usage.currentTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens: usage.currentTokens,
    lastUsedTokens: usage.currentTokens,
    ...(usage.tokenLimit > 0 ? { maxTokens: usage.tokenLimit } : {}),
    compactsAutomatically: true,
  };
}

function normalizeCopilotAssistantTokenUsage(
  usage: Extract<SessionEvent, { type: "assistant.usage" }>["data"],
): ThreadTokenUsageSnapshot | undefined {
  const inputTokens = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.cacheReadTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const usedTokens = inputTokens + cachedInputTokens + outputTokens;

  if (usedTokens <= 0) {
    return undefined;
  }

  const totalProcessedTokens = usedTokens + (usage.cacheWriteTokens ?? 0);
  return {
    usedTokens,
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    lastUsedTokens: usedTokens,
    ...(inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens > 0 ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(usage.duration !== undefined && usage.duration >= 0 ? { durationMs: usage.duration } : {}),
    compactsAutomatically: true,
  };
}

function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor.trim();
  }
  const record = asRecord(resumeCursor);
  const sessionId = normalizeString(record?.sessionId);
  return sessionId;
}

function toCopilotSessionMode(interactionMode: "default" | "plan"): "interactive" | "plan" {
  return interactionMode === "plan" ? "plan" : "interactive";
}

function toInteractionMode(mode: string): "default" | "plan" {
  return mode === "plan" ? "plan" : "default";
}

function approvalDecisionToPermissionResult(
  decision: ProviderApprovalDecision,
): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
    case "cancel":
    default:
      return { kind: "denied-interactively-by-user" };
  }
}

function requestTypeFromPermissionRequest(request: PermissionRequest) {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval" as const;
    case "write":
      return "file_change_approval" as const;
    case "read":
      return "file_read_approval" as const;
    case "custom-tool":
      return classifyToolRequestType(
        trimToUndefined(String(request.toolTitle ?? request.toolName ?? "")) ?? "tool",
      );
    case "mcp":
      return classifyToolRequestType(
        trimToUndefined(
          String(request.toolTitle ?? request.toolName ?? request.mcpToolName ?? ""),
        ) ?? "tool",
      );
    case "url":
      return "dynamic_tool_call" as const;
    default:
      return "unknown" as const;
  }
}

function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function toolDisplayTitle(toolName: string): string | undefined {
  const normalized = normalizeToolName(toolName);

  if (
    normalized === "view" ||
    normalized === "read" ||
    normalized === "read file" ||
    normalized === "read files" ||
    normalized === "view file" ||
    normalized === "view files"
  ) {
    return "Read file";
  }

  if (normalized === "grep") {
    return "Grep";
  }

  if (normalized === "glob") {
    return "Glob";
  }

  if (
    normalized === "search code" ||
    normalized === "search file" ||
    normalized === "search files" ||
    normalized === "find file" ||
    normalized === "find files"
  ) {
    return "Search files";
  }

  if (normalized === "list directory" || normalized === "list directories") {
    return "List directory";
  }

  return undefined;
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return (
    normalized === "read" ||
    normalized.startsWith("read ") ||
    normalized.includes("read file") ||
    normalized === "view" ||
    normalized.startsWith("view ") ||
    normalized.includes("view file") ||
    normalized === "grep" ||
    normalized === "glob" ||
    normalized.includes("search code") ||
    normalized.includes("search file") ||
    normalized.includes("find file") ||
    normalized.includes("list directory")
  );
}

function classifyToolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = normalizeToolName(toolName);

  if (
    normalized.includes("agent") ||
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

  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }

  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }

  if (normalized.includes("image")) {
    return "image_view";
  }

  if (isReadOnlyToolName(toolName)) {
    return "dynamic_tool_call";
  }

  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete") ||
    normalized.includes("rename") ||
    normalized.includes("move") ||
    normalized.includes("modify") ||
    normalized.includes("apply")
  ) {
    return "file_change";
  }

  return "dynamic_tool_call";
}

function classifyToolRequestType(
  toolName: string,
):
  | "command_execution_approval"
  | "file_change_approval"
  | "file_read_approval"
  | "dynamic_tool_call" {
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

function requestDetailFromPermissionRequest(request: PermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return trimToUndefined(String(request.fullCommandText ?? ""));
    case "write":
      return trimToUndefined(String(request.fileName ?? request.intention ?? ""));
    case "read":
      return trimToUndefined(String(request.path ?? request.intention ?? ""));
    case "mcp":
      return trimToUndefined(String(request.toolTitle ?? request.toolName ?? ""));
    case "url":
      return trimToUndefined(String(request.url ?? request.intention ?? ""));
    case "custom-tool":
      return trimToUndefined(String(request.toolName ?? request.toolDescription ?? ""));
    default:
      return undefined;
  }
}

function itemTypeFromToolEvent(event: Extract<SessionEvent, { type: "tool.execution_start" }>) {
  return event.data.mcpToolName ? "mcp_tool_call" : classifyToolItemType(event.data.toolName);
}

function toolTitleFromItemType(itemType: ToolLifecycleItemType, toolName?: string): string {
  if (toolName && itemType === "dynamic_tool_call") {
    const dynamicToolTitle = toolDisplayTitle(toolName);
    if (dynamicToolTitle) {
      return dynamicToolTitle;
    }
  }

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
  }
}

function summarizeArgumentList(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => entry !== undefined);
  const [firstValue] = values;
  if (!firstValue) {
    return undefined;
  }
  return values.length === 1 ? firstValue : `${firstValue} +${values.length - 1} more`;
}

function toolArgumentDetail(argumentsValue: { readonly [k: string]: unknown } | undefined) {
  if (!argumentsValue) {
    return undefined;
  }

  for (const key of ["path", "directory", "dir", "pattern", "glob", "query", "url", "command"]) {
    const value = normalizeString(argumentsValue[key]);
    if (value) {
      return value;
    }
  }

  for (const key of ["paths", "files", "globs", "patterns"]) {
    const value = summarizeArgumentList(argumentsValue[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function toolDetailFromEvent(data: {
  readonly toolName?: string;
  readonly mcpToolName?: string;
  readonly mcpServerName?: string;
  readonly arguments?: {
    readonly [k: string]: unknown;
  };
}) {
  const argumentDetail = toolArgumentDetail(data.arguments);
  if (argumentDetail) {
    return argumentDetail;
  }
  if (data.mcpToolName || data.mcpServerName) {
    return trimToUndefined([data.mcpServerName, data.mcpToolName ?? data.toolName].join(" / "));
  }
  return undefined;
}

function toolResultSummaryContent(
  result: { readonly content?: string } | undefined,
): string | undefined {
  return trimToUndefined(result?.content);
}

function toolResultDetailContent(
  result:
    | {
        readonly content?: string;
        readonly detailedContent?: string;
      }
    | undefined,
): string | undefined {
  return trimToUndefined(result?.detailedContent) ?? trimToUndefined(result?.content);
}

function completedToolDetail(input: {
  readonly itemType: ToolLifecycleItemType;
  readonly success: boolean;
  readonly startedDetail: string | undefined;
  readonly resultDetail: string | undefined;
}): string | undefined {
  if (!input.success) {
    return input.resultDetail ?? input.startedDetail;
  }

  if (
    input.startedDetail &&
    (input.itemType === "dynamic_tool_call" ||
      input.itemType === "file_change" ||
      input.itemType === "web_search" ||
      input.itemType === "image_view")
  ) {
    return input.startedDetail;
  }

  return input.resultDetail ?? input.startedDetail;
}

function looksLikeDiffDetail(detail: string | undefined): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.trim();
  return (
    normalized.startsWith("diff --git ") ||
    (/^---\s/m.test(normalized) && /^\+\+\+\s/m.test(normalized))
  );
}

function normalizeDiffPath(value: string): string {
  if (value === "/dev/null") {
    return value;
  }
  if (value.startsWith("a/") || value.startsWith("b/")) {
    return value.slice(2);
  }
  return value;
}

function extractChangedFilesFromDiff(detail: string | undefined): string[] {
  if (!looksLikeDiffDetail(detail)) {
    return [];
  }
  const normalizedDetail = detail?.trim();
  if (!normalizedDetail) {
    return [];
  }

  const changedFiles: string[] = [];
  const seen = new Set<string>();
  const pushChangedFile = (value: string | undefined) => {
    const normalized = trimToUndefined(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    changedFiles.push(normalized);
  };

  for (const match of normalizedDetail.matchAll(
    /^diff --git\s+(?<before>\S+)\s+(?<after>\S+)$/gm,
  )) {
    const beforePath = normalizeDiffPath(match.groups?.before ?? "");
    const afterPath = normalizeDiffPath(match.groups?.after ?? "");
    pushChangedFile(afterPath !== "/dev/null" ? afterPath : beforePath);
  }

  if (changedFiles.length > 0) {
    return changedFiles;
  }

  for (const match of normalizedDetail.matchAll(/^(?:---|\+\+\+)\s+(?<path>\S+)$/gm)) {
    const path = normalizeDiffPath(match.groups?.path ?? "");
    if (path === "/dev/null") {
      continue;
    }
    pushChangedFile(path);
  }

  return changedFiles;
}

function withRefs(input: {
  readonly threadId: ThreadId;
  readonly eventId: EventId;
  readonly createdAt: string;
  readonly turnId: TurnId | undefined;
  readonly providerTurnId?: TurnId | undefined;
  readonly itemId: string | undefined;
  readonly requestId: string | undefined;
  readonly rawMethod: string | undefined;
  readonly rawPayload: unknown;
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const providerTurnId = input.providerTurnId ?? input.turnId;
  const runtimeItemId = toRuntimeItemId(input.itemId);
  const runtimeRequestId = toRuntimeRequestId(input.requestId);
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = trimToUndefined(input.requestId);
  return {
    eventId: input.eventId,
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(runtimeItemId ? { itemId: runtimeItemId } : {}),
    ...(runtimeRequestId ? { requestId: runtimeRequestId } : {}),
    ...(providerTurnId || providerItemId || providerRequestId
      ? {
          providerRefs: {
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
          },
        }
      : {}),
    raw: {
      source: input.rawMethod ? "copilot.sdk.session-event" : "copilot.sdk.synthetic",
      ...(input.rawMethod ? { method: input.rawMethod } : {}),
      payload: input.rawPayload,
    },
  };
}

function mapHistoryToTurns(
  threadId: ThreadId,
  events: ReadonlyArray<SessionEvent>,
): ProviderThreadSnapshot {
  const turns: Array<ProviderThreadTurnSnapshot> = [];
  let current: { id: TurnId; items: Array<unknown> } | undefined;

  for (const event of events) {
    if (event.type === "assistant.turn_start") {
      current = {
        id: TurnId.makeUnsafe(event.data.turnId),
        items: [event],
      };
      turns.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    current.items.push(event);
    if (isCopilotTurnTerminalEvent(event)) {
      current = undefined;
    }
  }

  return {
    threadId,
    turns: turns.map((turn) => ({
      id: turn.id,
      items: turn.items,
    })),
  };
}

function makeSyntheticEvent(
  threadId: ThreadId,
  type: ProviderRuntimeEvent["type"],
  payload: ProviderRuntimeEvent["payload"],
  extra?: {
    readonly turnId?: TurnId | undefined;
    readonly itemId?: string | undefined;
    readonly requestId?: string | undefined;
  },
): ProviderRuntimeEvent {
  return {
    ...withRefs({
      threadId,
      eventId: makeEventId("copilot-synthetic"),
      createdAt: new Date().toISOString(),
      turnId: extra?.turnId,
      itemId: extra?.itemId,
      requestId: extra?.requestId,
      rawMethod: undefined,
      rawPayload: payload,
    }),
    type,
    payload,
  } as ProviderRuntimeEvent;
}

function resolveUserInputAnswer(
  pending: PendingUserInputRequest,
  answers: ProviderUserInputAnswers,
): CopilotUserInputResponse {
  const direct = answers[USER_INPUT_QUESTION_ID];
  const candidate =
    typeof direct === "string"
      ? direct
      : Object.values(answers).find((value): value is string => typeof value === "string");
  const answer = trimToUndefined(candidate) ?? "";
  return {
    answer,
    wasFreeform: !pending.request.choices?.includes(answer),
  };
}

function createSessionRecord(input: {
  readonly threadId: ThreadId;
  readonly client: CopilotClientHandle;
  readonly session: CopilotSessionHandle;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly pendingApprovalResolvers: Map<string, PendingApprovalRequest>;
  readonly pendingUserInputResolvers: Map<string, PendingUserInputRequest>;
  readonly cwd: string | undefined;
  readonly configDir: string | undefined;
  readonly model: string | undefined;
  readonly reasoningEffort: CodexReasoningEffort | undefined;
}): ActiveCopilotSession {
  return {
    client: input.client,
    session: input.session,
    threadId: input.threadId,
    createdAt: new Date().toISOString(),
    runtimeMode: input.runtimeMode,
    cwd: input.cwd,
    configDir: input.configDir,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    interactionMode: undefined,
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    currentTurnId: undefined,
    currentProviderTurnId: undefined,
    pendingCompletionTurnId: undefined,
    pendingCompletionProviderTurnId: undefined,
    pendingTurnIds: [],
    pendingTurnUsage: undefined,
    toolItemTypesByCallId: new Map(),
    toolTitlesByCallId: new Map(),
    toolDetailsByCallId: new Map(),
    pendingApprovalResolvers: input.pendingApprovalResolvers,
    pendingUserInputResolvers: input.pendingUserInputResolvers,
    unsubscribe: () => undefined,
  };
}

const makeCopilotAdapter = (options?: CopilotAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const nativeEventLogger = options?.nativeEventLogger;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ActiveCopilotSession>();

    const emitRuntimeEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
      Effect.runPromise(Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid)).catch(
        () => undefined,
      );

    const writeNativeEvent = (threadId: ThreadId, event: SessionEvent) => {
      if (!nativeEventLogger) return Promise.resolve();
      return Effect.runPromise(nativeEventLogger.write(event, threadId)).catch(() => undefined);
    };

    const currentSyntheticTurnId = (record: ActiveCopilotSession) =>
      completionTurnRefs(record).turnId ?? record.currentTurnId;

    const syncInteractionMode = (
      record: ActiveCopilotSession,
      interactionMode: "default" | "plan",
    ) => {
      if (record.interactionMode === interactionMode) {
        return Effect.void;
      }
      return Effect.tryPromise({
        try: async () => {
          await record.session.rpc.mode.set({
            mode: toCopilotSessionMode(interactionMode),
          });
          record.interactionMode = interactionMode;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.mode.set",
            detail: toMessage(cause, "Failed to switch GitHub Copilot interaction mode."),
            cause,
          }),
      });
    };

    const emitLatestProposedPlan = (record: ActiveCopilotSession) =>
      Effect.tryPromise({
        try: () => record.session.rpc.plan.read(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.plan.read",
            detail: toMessage(cause, "Failed to read the GitHub Copilot plan."),
            cause,
          }),
      }).pipe(
        Effect.flatMap((plan) => {
          const planMarkdown = trimToUndefined(plan.content ?? undefined);
          if (!plan.exists || !planMarkdown) {
            return Effect.void;
          }
          return Queue.offer(
            runtimeEventQueue,
            makeSyntheticEvent(
              record.threadId,
              "turn.proposed.completed",
              {
                planMarkdown,
              },
              { turnId: currentSyntheticTurnId(record) },
            ),
          ).pipe(Effect.asVoid);
        }),
      );

    const mapSessionEvent = (
      record: ActiveCopilotSession,
      event: SessionEvent,
    ): ReadonlyArray<ProviderRuntimeEvent> => {
      const currentTurnId = record.currentTurnId;
      const currentProviderTurnId = record.currentProviderTurnId;
      const resolveOrchestrationTurnId = (
        providerTurnId: TurnId | undefined,
      ): TurnId | undefined => {
        if (providerTurnId && currentProviderTurnId && providerTurnId === currentProviderTurnId) {
          return currentTurnId ?? providerTurnId;
        }
        return currentTurnId ?? providerTurnId;
      };
      const base = (input?: {
        readonly turnId?: TurnId | undefined;
        readonly providerTurnId?: TurnId | undefined;
        readonly itemId?: string | undefined;
        readonly requestId?: string | undefined;
      }) =>
        withRefs({
          threadId: record.threadId,
          eventId: EventId.makeUnsafe(event.id),
          createdAt: event.timestamp,
          turnId: resolveOrchestrationTurnId(input?.providerTurnId ?? input?.turnId),
          providerTurnId: input?.providerTurnId ?? input?.turnId,
          itemId: input?.itemId,
          requestId: input?.requestId,
          rawMethod: event.type,
          rawPayload: event,
        });

      switch (event.type) {
        case "session.start":
        case "session.resume":
          return [
            {
              ...base(),
              type: "session.started",
              payload: {
                message:
                  event.type === "session.resume"
                    ? "Resumed GitHub Copilot session"
                    : "Started GitHub Copilot session",
                resume: event.data,
              },
            },
            {
              ...base(),
              type: "thread.started",
              payload: {
                providerThreadId:
                  event.type === "session.start" ? event.data.sessionId : record.session.sessionId,
              },
            },
          ];
        case "session.info":
          return [
            {
              ...base(),
              type: "runtime.warning",
              payload: {
                message: event.data.message,
                detail: event.data,
              },
            },
          ];
        case "session.warning":
          return [
            {
              ...base(),
              type: "runtime.warning",
              payload: {
                message: event.data.message,
                detail: event.data,
              },
            },
          ];
        case "session.error":
          return [
            {
              ...base(),
              type: "runtime.error",
              payload: {
                message: event.data.message,
                class: "provider_error",
                detail: event.data,
              },
            },
            {
              ...base(),
              type: "session.state.changed",
              payload: {
                state: "error",
                reason: "session.error",
                detail: event.data,
              },
            },
          ];
        case "session.idle": {
          const idleCompletionRefs = completionTurnRefs(record);
          const idleCompletionEvents: ProviderRuntimeEvent[] =
            idleCompletionRefs.turnId || idleCompletionRefs.providerTurnId
              ? [
                  {
                    ...base(idleCompletionRefs),
                    type: "turn.completed",
                    payload: {
                      state: "completed",
                      ...assistantUsageFields(record.pendingTurnUsage),
                    },
                  } satisfies ProviderRuntimeEvent,
                ]
              : [];
          return [
            ...idleCompletionEvents,
            {
              ...base(),
              type: "session.state.changed",
              payload: {
                state: "ready",
                reason: "session.idle",
              },
            },
            {
              ...base(),
              type: "thread.state.changed",
              payload: {
                state: "idle",
                detail: event.data,
              },
            },
          ];
        }
        case "session.title_changed":
          return [
            {
              ...base(),
              type: "thread.metadata.updated",
              payload: {
                name: event.data.title,
                metadata: event.data,
              },
            },
          ];
        case "session.model_change":
          return [
            {
              ...base(),
              type: "model.rerouted",
              payload: {
                fromModel: event.data.previousModel ?? "unknown",
                toModel: event.data.newModel,
                reason: "session.model_change",
              },
            },
          ];
        case "session.plan_changed":
          return [
            {
              ...base(),
              type: "turn.plan.updated",
              payload: {
                explanation: `Plan ${event.data.operation}d`,
                plan: [],
              },
            },
          ];
        case "session.workspace_file_changed":
          return [
            {
              ...base(),
              type: "files.persisted",
              payload: {
                files: [
                  {
                    filename: event.data.path,
                    fileId: event.data.path,
                  },
                ],
              },
            },
          ];
        case "session.context_changed":
          return [
            {
              ...base(),
              type: "thread.metadata.updated",
              payload: {
                metadata: event.data,
              },
            },
          ];
        case "session.usage_info": {
          const usage = normalizeCopilotSessionTokenUsage(event.data);
          if (!usage) {
            return [];
          }
          return [
            {
              ...base(),
              type: "thread.token-usage.updated",
              payload: {
                usage,
              },
            },
          ];
        }
        case "session.task_complete":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId:
                  toRuntimeTaskId(record.threadId) ?? RuntimeTaskId.makeUnsafe(record.threadId),
                status: "completed",
                ...(trimToUndefined(event.data.summary) ? { summary: event.data.summary } : {}),
              },
            },
          ];
        case "assistant.turn_start":
          return [
            {
              ...base({ providerTurnId: toTurnId(event.data.turnId) }),
              type: "turn.started",
              payload: record.model ? { model: record.model } : {},
            },
            {
              ...base({ providerTurnId: toTurnId(event.data.turnId) }),
              type: "session.state.changed",
              payload: {
                state: "running",
                reason: "assistant.turn_start",
              },
            },
          ];
        case "assistant.reasoning":
          return [
            {
              ...base({ itemId: event.data.reasoningId }),
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: "completed",
                title: "Reasoning",
                detail: trimToUndefined(event.data.content),
                data: event.data,
              },
            },
          ];
        case "assistant.reasoning_delta":
          return [
            {
              ...base({ itemId: event.data.reasoningId }),
              type: "content.delta",
              payload: {
                streamKind: "reasoning_text",
                delta: event.data.deltaContent,
              },
            },
          ];
        case "assistant.message":
          return [
            {
              ...base({ itemId: event.data.messageId }),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                detail: trimToUndefined(event.data.content),
                data: event.data,
              },
            },
          ];
        case "assistant.message_delta":
          return [
            {
              ...base({ itemId: event.data.messageId }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: event.data.deltaContent,
              },
            },
          ];
        case "assistant.turn_end":
          return [];
        case "assistant.usage": {
          const usage = normalizeCopilotAssistantTokenUsage(event.data);
          if (!usage) {
            return [];
          }
          const completionRefs = completionTurnRefs(record);
          const completionBase =
            completionRefs.turnId || completionRefs.providerTurnId ? base(completionRefs) : base();
          return [
            {
              ...completionBase,
              type: "thread.token-usage.updated",
              payload: {
                usage,
              },
            },
          ];
        }
        case "abort": {
          const abortedTurnRefs = completionTurnRefs(record);
          const abortedBase =
            abortedTurnRefs.turnId || abortedTurnRefs.providerTurnId
              ? base(abortedTurnRefs)
              : base();
          return [
            {
              ...abortedBase,
              type: "turn.aborted",
              payload: {
                reason: event.data.reason,
              },
            },
          ];
        }
        case "tool.execution_start": {
          const startedItemType = itemTypeFromToolEvent(event);
          const startedTitle = toolTitleFromItemType(startedItemType, event.data.toolName);
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "item.started",
              payload: {
                itemType: startedItemType,
                status: "inProgress",
                title: startedTitle,
                ...(toolDetailFromEvent(event.data)
                  ? { detail: toolDetailFromEvent(event.data) }
                  : {}),
                data: event.data,
              },
            },
          ];
        }
        case "tool.execution_progress":
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "tool.progress",
              payload: {
                toolUseId: event.data.toolCallId,
                summary: event.data.progressMessage,
              },
            },
          ];
        case "tool.execution_partial_result":
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "tool.progress",
              payload: {
                toolUseId: event.data.toolCallId,
                summary: event.data.partialOutput,
              },
            },
          ];
        case "tool.execution_complete": {
          const resultDetail = toolResultDetailContent(event.data.result);
          const completedItemType =
            record.toolItemTypesByCallId.get(event.data.toolCallId) ??
            (event.data.result?.contents?.some((content) => content.type === "terminal")
              ? "command_execution"
              : "dynamic_tool_call");
          const diffChangedFiles =
            completedItemType === "file_change" ? extractChangedFilesFromDiff(resultDetail) : [];
          const completedTitle =
            record.toolTitlesByCallId.get(event.data.toolCallId) ??
            toolTitleFromItemType(completedItemType);
          const completedDetail = completedToolDetail({
            itemType: completedItemType,
            success: event.data.success,
            startedDetail: record.toolDetailsByCallId.get(event.data.toolCallId),
            resultDetail,
          });
          const completedSummary = toolResultSummaryContent(event.data.result);
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "item.completed",
              payload: {
                itemType: completedItemType,
                status: event.data.success ? "completed" : "failed",
                title: completedTitle,
                ...(completedDetail ? { detail: completedDetail } : {}),
                data:
                  diffChangedFiles.length > 0
                    ? {
                        ...event.data,
                        changes: diffChangedFiles.map((path) => ({ path })),
                      }
                    : event.data,
              },
            },
            ...(completedSummary
              ? [
                  {
                    ...base({ itemId: event.data.toolCallId }),
                    type: "tool.summary" as const,
                    payload: {
                      summary: completedSummary,
                      precedingToolUseIds: [event.data.toolCallId],
                    },
                  },
                ]
              : []),
          ];
        }
        case "skill.invoked":
          return [
            {
              ...base(),
              type: "task.progress",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.name) ?? RuntimeTaskId.makeUnsafe(event.data.name),
                description: `Invoked skill ${event.data.name}`,
              },
            },
          ];
        case "subagent.started":
          return [
            {
              ...base(),
              type: "task.started",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.toolCallId) ??
                  RuntimeTaskId.makeUnsafe(event.data.toolCallId),
                description: trimToUndefined(event.data.agentDescription),
                taskType: "subagent",
              },
            },
          ];
        case "subagent.completed":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.toolCallId) ??
                  RuntimeTaskId.makeUnsafe(event.data.toolCallId),
                status: "completed",
                ...(trimToUndefined(event.data.agentDisplayName)
                  ? { summary: event.data.agentDisplayName }
                  : {}),
              },
            },
          ];
        case "subagent.failed":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.toolCallId) ??
                  RuntimeTaskId.makeUnsafe(event.data.toolCallId),
                status: "failed",
                ...(trimToUndefined(event.data.error) ? { summary: event.data.error } : {}),
              },
            },
          ];
        default:
          return [];
      }
    };

    const createInteractionHandlers = (
      threadId: ThreadId,
      getCurrentTurnId: () => TurnId | undefined,
      getRuntimeMode: () => ProviderSession["runtimeMode"],
      pendingApprovalResolvers: Map<string, PendingApprovalRequest>,
      pendingUserInputResolvers: Map<string, PendingUserInputRequest>,
    ) => {
      const onPermissionRequest = (request: PermissionRequest) =>
        getRuntimeMode() === "full-access"
          ? Promise.resolve<PermissionRequestResult>({ kind: "approved" })
          : new Promise<PermissionRequestResult>((resolve) => {
              const requestId = `copilot-approval-${randomUUID()}`;
              const turnId = getCurrentTurnId();
              pendingApprovalResolvers.set(requestId, {
                requestType: requestTypeFromPermissionRequest(request),
                turnId,
                resolve,
              });
              void emitRuntimeEvents([
                makeSyntheticEvent(
                  threadId,
                  "request.opened",
                  {
                    requestType: requestTypeFromPermissionRequest(request),
                    ...(requestDetailFromPermissionRequest(request)
                      ? { detail: requestDetailFromPermissionRequest(request) }
                      : {}),
                    args: request,
                  },
                  { requestId, turnId },
                ),
              ]);
            });

      const onUserInputRequest = (request: CopilotUserInputRequest) =>
        new Promise<CopilotUserInputResponse>((resolve) => {
          const requestId = `copilot-user-input-${randomUUID()}`;
          const turnId = getCurrentTurnId();
          pendingUserInputResolvers.set(requestId, {
            request,
            turnId,
            resolve,
          });
          void emitRuntimeEvents([
            makeSyntheticEvent(
              threadId,
              "user-input.requested",
              {
                questions: [
                  {
                    id: USER_INPUT_QUESTION_ID,
                    header: USER_INPUT_QUESTION_HEADER,
                    question: request.question,
                    options: (request.choices ?? []).map((choice: string) => ({
                      label: choice,
                      description: choice,
                    })),
                  },
                ],
              },
              { requestId, turnId },
            ),
          ]);
        });

      return {
        onPermissionRequest,
        onUserInputRequest,
      };
    };

    const validateSessionConfiguration = (input: {
      readonly client: CopilotClientHandle;
      readonly threadId: ThreadId;
      readonly model: string | undefined;
      readonly reasoningEffort: CodexReasoningEffort | undefined;
    }) =>
      Effect.gen(function* () {
        if (!input.model && !input.reasoningEffort) {
          return;
        }

        yield* Effect.tryPromise({
          try: () => input.client.start(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start GitHub Copilot client."),
              cause,
            }),
        });

        const supportedModels = mapSupportedModelsById(
          yield* Effect.tryPromise({
            try: () => input.client.listModels(),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to load GitHub Copilot model metadata."),
                cause,
              }),
          }),
        );
        const selectedModel = input.model ? supportedModels.get(input.model) : undefined;

        if (input.model && !selectedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.model",
            issue: `GitHub Copilot model '${input.model}' is not available in the current Copilot runtime.`,
          });
        }

        if (!input.reasoningEffort) {
          return;
        }

        if (!selectedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.reasoningEffort",
            issue:
              "GitHub Copilot reasoning effort requires an explicit supported model selection.",
          });
        }

        const supportedReasoningEfforts = selectedModel.supportedReasoningEfforts ?? [];
        if (supportedReasoningEfforts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.reasoningEffort",
            issue: `GitHub Copilot model '${selectedModel.id}' does not support reasoning effort configuration.`,
          });
        }

        if (!supportedReasoningEfforts.includes(input.reasoningEffort)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.reasoningEffort",
            issue: `GitHub Copilot model '${selectedModel.id}' does not support reasoning effort '${input.reasoningEffort}'.`,
          });
        }
      });

    const reconfigureSession = (
      record: ActiveCopilotSession,
      input: {
        readonly model: string | undefined;
        readonly reasoningEffort: CodexReasoningEffort | undefined;
      },
    ) =>
      Effect.tryPromise({
        try: async () => {
          if (
            input.model &&
            (input.model !== record.model || input.reasoningEffort !== record.reasoningEffort)
          ) {
            await record.session.rpc.model.switchTo({
              modelId: input.model,
              ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            });
          }
          record.model = input.model;
          record.reasoningEffort = input.reasoningEffort;
          record.updatedAt = new Date().toISOString();
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.model.switchTo",
            detail: toMessage(cause, "Failed to reconfigure GitHub Copilot session."),
            cause,
          }),
      });

    const handleSessionEvent = (record: ActiveCopilotSession, event: SessionEvent) => {
      record.updatedAt = event.timestamp;
      if (event.type === "assistant.turn_start") {
        beginCopilotTurn(record, TurnId.makeUnsafe(event.data.turnId));
      }
      if (event.type === "assistant.usage") {
        recordTurnUsage(record, event.data);
      }
      if (event.type === "session.error") {
        record.lastError = event.data.message;
      }
      if (event.type === "session.model_change") {
        record.model = event.data.newModel;
      }
      if (event.type === "session.mode_changed") {
        record.interactionMode = toInteractionMode(event.data.newMode);
      }
      if (event.type === "tool.execution_start") {
        const itemType = itemTypeFromToolEvent(event);
        record.toolItemTypesByCallId.set(event.data.toolCallId, itemType);
        record.toolTitlesByCallId.set(
          event.data.toolCallId,
          toolTitleFromItemType(itemType, event.data.toolName),
        );
        const toolDetail = toolDetailFromEvent(event.data);
        if (toolDetail) {
          record.toolDetailsByCallId.set(event.data.toolCallId, toolDetail);
        }
      }

      void writeNativeEvent(record.threadId, event);
      const runtimeEvents = mapSessionEvent(record, event);
      if (runtimeEvents.length > 0) {
        void emitRuntimeEvents(runtimeEvents);
      }
      if (event.type === "session.plan_changed" && event.data.operation !== "delete") {
        void Effect.runPromise(emitLatestProposedPlan(record)).catch((cause) => {
          void emitRuntimeEvents([
            makeSyntheticEvent(
              record.threadId,
              "runtime.warning",
              {
                message: "Failed to read GitHub Copilot plan.",
                detail: toMessage(cause, "Failed to read GitHub Copilot plan."),
              },
              { turnId: currentSyntheticTurnId(record) },
            ),
          ]);
        });
      }
      if (event.type === "tool.execution_complete") {
        record.toolItemTypesByCallId.delete(event.data.toolCallId);
        record.toolTitlesByCallId.delete(event.data.toolCallId);
        record.toolDetailsByCallId.delete(event.data.toolCallId);
      }
      if (event.type === "assistant.turn_end") {
        markTurnAwaitingCompletion(record);
      }
      if (event.type === "abort" || event.type === "session.idle") {
        clearTurnTracking(record);
      }
    };

    const getSessionRecord = (threadId: ThreadId) => {
      const record = sessions.get(threadId);
      if (!record) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(record);
    };

    const stopRecord = async (record: ActiveCopilotSession) => {
      record.unsubscribe();
      try {
        await closeCopilotSession(record.session);
      } catch {
        // best effort
      }
      try {
        await record.client.stop();
      } catch {
        // best effort
      }
      for (const pending of record.pendingApprovalResolvers.values()) {
        pending.resolve({ kind: "denied-interactively-by-user" });
      }
      record.pendingApprovalResolvers.clear();
      for (const pending of record.pendingUserInputResolvers.values()) {
        pending.resolve({ answer: "", wasFreeform: true });
      }
      record.pendingUserInputResolvers.clear();
      sessions.delete(record.threadId);
    };

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}', received '${input.provider}'.`,
          });
        }
        if (input.modelSelection !== undefined && input.modelSelection.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected modelSelection.provider '${PROVIDER}', received '${input.modelSelection.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing) {
          return {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: existing.runtimeMode,
            ...(existing.cwd ? { cwd: existing.cwd } : {}),
            ...(existing.model ? { model: existing.model } : {}),
            threadId: input.threadId,
            resumeCursor: existing.session.sessionId,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
            ...(existing.lastError ? { lastError: existing.lastError } : {}),
          } satisfies ProviderSession;
        }

        const cliPath =
          normalizeCopilotCliPathOverride(input.providerOptions?.copilot?.cliPath) ??
          resolveBundledCopilotCliPath();
        const configDir = trimToUndefined(input.providerOptions?.copilot?.configDir);
        const resumeSessionId = extractResumeSessionId(input.resumeCursor);
        const clientOptions: CopilotClientOptions = {
          ...(cliPath ? { cliPath } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          logLevel: "error",
        };
        const client = options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);
        const pendingApprovalResolvers = new Map<string, PendingApprovalRequest>();
        const pendingUserInputResolvers = new Map<string, PendingUserInputRequest>();
        const modelSelection = getCopilotModelSelection(input);
        const selectedModel = modelSelection?.model;
        const reasoningEffort = getCopilotReasoningEffort(modelSelection);
        let sessionRecord: ActiveCopilotSession | undefined;
        const handlers = createInteractionHandlers(
          input.threadId,
          () => sessionRecord?.currentTurnId,
          () => sessionRecord?.runtimeMode ?? input.runtimeMode,
          pendingApprovalResolvers,
          pendingUserInputResolvers,
        );

        yield* validateSessionConfiguration({
          client,
          threadId: input.threadId,
          model: selectedModel,
          reasoningEffort,
        });

        const session = yield* Effect.tryPromise({
          try: async () => {
            if (resumeSessionId) {
              return client.resumeSession(resumeSessionId, {
                ...handlers,
                ...(selectedModel ? { model: selectedModel } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
                ...(input.cwd ? { workingDirectory: input.cwd } : {}),
                ...(configDir ? { configDir } : {}),
                streaming: true,
              });
            }
            const sessionConfig: Parameters<CopilotClient["createSession"]>[0] & {
              sessionId?: string;
            } = {
              ...handlers,
              sessionId: makeCopilotSessionId(input.threadId),
              ...(selectedModel ? { model: selectedModel } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
              ...(input.cwd ? { workingDirectory: input.cwd } : {}),
              ...(configDir ? { configDir } : {}),
              streaming: true,
            };
            return client.createSession(sessionConfig);
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start GitHub Copilot session."),
              cause,
            }),
        });

        const record = createSessionRecord({
          threadId: input.threadId,
          client,
          session,
          runtimeMode: input.runtimeMode,
          pendingApprovalResolvers,
          pendingUserInputResolvers,
          cwd: input.cwd,
          configDir,
          model: selectedModel,
          reasoningEffort,
        });
        const unsubscribe = session.on((event) => {
          handleSessionEvent(record, event);
        });
        record.unsubscribe = unsubscribe;
        sessionRecord = record;
        sessions.set(input.threadId, record);

        yield* Queue.offerAll(runtimeEventQueue, [
          makeSyntheticEvent(input.threadId, "session.started", {
            message: resumeSessionId
              ? "Resumed GitHub Copilot session"
              : "Started GitHub Copilot session",
            resume: { sessionId: session.sessionId },
          }),
          makeSyntheticEvent(input.threadId, "session.configured", {
            config: {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(selectedModel ? { model: selectedModel } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
              ...(configDir ? { configDir } : {}),
              streaming: true,
            },
          }),
          makeSyntheticEvent(input.threadId, "thread.started", {
            providerThreadId: session.sessionId,
          }),
          makeSyntheticEvent(input.threadId, "session.state.changed", {
            state: "ready",
            reason: "session.started",
          }),
        ]);

        return {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          threadId: input.threadId,
          resumeCursor: session.sessionId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        } satisfies ProviderSession;
      });

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(input.threadId);
        if (input.modelSelection !== undefined && input.modelSelection.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Expected modelSelection.provider '${PROVIDER}', received '${input.modelSelection.provider}'.`,
          });
        }

        const modelSelection = getCopilotModelSelection(input);
        const explicitReasoningEffort = getCopilotReasoningEffort(modelSelection);
        const nextModel = modelSelection?.model ?? record.model;
        const nextReasoningEffort =
          explicitReasoningEffort !== undefined
            ? explicitReasoningEffort
            : modelSelection?.model && modelSelection.model !== record.model
              ? undefined
              : record.reasoningEffort;
        const shouldReconfigure =
          nextModel !== record.model || nextReasoningEffort !== record.reasoningEffort;
        const attachments = yield* Effect.forEach(input.attachments ?? [], (attachment) => {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
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
            path: attachmentPath,
            displayName: attachment.name,
          });
        });

        if (shouldReconfigure) {
          yield* validateSessionConfiguration({
            client: record.client,
            threadId: input.threadId,
            model: nextModel,
            reasoningEffort: nextReasoningEffort,
          });
          yield* reconfigureSession(record, {
            model: nextModel,
            reasoningEffort: nextReasoningEffort,
          });
        }

        const interactionMode = input.interactionMode ?? record.interactionMode ?? "default";
        yield* syncInteractionMode(record, interactionMode);

        const turnId = TurnId.makeUnsafe(`copilot-turn-${randomUUID()}`);
        record.pendingTurnIds.push(turnId);
        record.currentTurnId = turnId;
        record.currentProviderTurnId = undefined;

        yield* Effect.tryPromise({
          try: () =>
            record.session.send({
              prompt: input.input ?? "",
              ...(attachments.length > 0 ? { attachments } : {}),
              mode: "enqueue",
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.send",
              detail: toMessage(cause, "Failed to send GitHub Copilot turn."),
              cause,
            }),
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              record.pendingTurnIds = record.pendingTurnIds.filter(
                (candidate) => candidate !== turnId,
              );
              if (record.currentTurnId === turnId) {
                record.currentTurnId = undefined;
              }
            }),
          ),
        );

        record.updatedAt = new Date().toISOString();

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: record.session.sessionId,
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        yield* Effect.tryPromise({
          try: () => record.session.abort(),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.abort",
              detail: toMessage(cause, "Failed to interrupt GitHub Copilot turn."),
              cause,
            }),
        });
      });

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        const pending = record.pendingApprovalResolvers.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.permission.respond",
            detail: `Unknown pending GitHub Copilot approval request '${requestId}'.`,
          });
        }
        record.pendingApprovalResolvers.delete(requestId);
        pending.resolve(approvalDecisionToPermissionResult(decision));
        yield* Queue.offer(
          runtimeEventQueue,
          makeSyntheticEvent(
            threadId,
            "request.resolved",
            {
              requestType: pending.requestType,
              decision,
              resolution: approvalDecisionToPermissionResult(decision),
            },
            { requestId, turnId: pending.turnId },
          ),
        );
      });

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        const pending = record.pendingUserInputResolvers.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.userInput.respond",
            detail: `Unknown pending GitHub Copilot user-input request '${requestId}'.`,
          });
        }
        record.pendingUserInputResolvers.delete(requestId);
        pending.resolve(resolveUserInputAnswer(pending, answers));
        yield* Queue.offer(
          runtimeEventQueue,
          makeSyntheticEvent(
            threadId,
            "user-input.resolved",
            {
              answers,
            },
            { requestId, turnId: pending.turnId },
          ),
        );
      });

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        yield* Effect.tryPromise({
          try: async () => {
            await stopRecord(record);
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to stop GitHub Copilot session."),
              cause,
            }),
        });
      });

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values()).map((record) =>
          Object.assign(
            {
              provider: PROVIDER,
              status: record.currentTurnId ? "running" : "ready",
              runtimeMode: record.runtimeMode,
              threadId: record.threadId,
              resumeCursor: record.session.sessionId,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            } satisfies ProviderSession,
            record.cwd ? { cwd: record.cwd } : undefined,
            record.model ? { model: record.model } : undefined,
            record.currentTurnId ? { activeTurnId: record.currentTurnId } : undefined,
            record.lastError ? { lastError: record.lastError } : undefined,
          ),
        ),
      );

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        return yield* Effect.tryPromise({
          try: async () => {
            const messages = await record.session.getMessages();
            return mapHistoryToTurns(threadId, messages);
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.getMessages",
              detail: toMessage(cause, "Failed to read GitHub Copilot thread history."),
              cause,
            }),
        });
      });

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = (_threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread.rollback",
          detail:
            "GitHub Copilot SDK does not expose a supported conversation rollback API for existing sessions.",
        }),
      );

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.tryPromise({
        try: async () => {
          await Promise.all(Array.from(sessions.values()).map((record) => stopRecord(record)));
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ThreadId.makeUnsafe("_all"),
            detail: toMessage(cause, "Failed to stop GitHub Copilot sessions."),
            cause,
          }),
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
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CopilotAdapterShape;
  });

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}
