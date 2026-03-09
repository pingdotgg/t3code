/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Uses the Claude Agent SDK to manage a long-lived session per thread, stream
 * structured runtime activity, and bridge permission / elicitation prompts
 * back into the shared provider abstraction.
 *
 * @module ClaudeCodeAdapterLive
 */
import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  type ClaudeCodeReasoningEffort,
  EventId,
  PROVIDER_CAPABILITIES_BY_PROVIDER,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type RuntimeErrorClass,
} from "@t3tools/contracts";
import {
  query as createClaudeQuery,
  type ElicitationRequest,
  type ElicitationResult,
  type PermissionResult,
  type Query as ClaudeQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { Effect, Layer, Queue, Stream } from "effect";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderThreadTurnSnapshot } from "../Services/ProviderAdapter.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeCode" as const;
const START_SESSION_TIMEOUT_MS = 30_000;
const STARTUP_MESSAGE_LABEL_LIMIT = 4;
const UNKNOWN_PENDING_APPROVAL_REQUEST = "Unknown pending approval request.";
const UNKNOWN_PENDING_USER_INPUT_REQUEST = "Unknown pending user input request.";

type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";

type PendingPermissionRequest = {
  readonly requestId: ApprovalRequestId;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly detail?: string;
  readonly args?: Record<string, unknown>;
  readonly suggestions?: ReadonlyArray<unknown>;
  readonly resolve: (value: PermissionResult) => void;
  readonly reject: (error: unknown) => void;
};

type PendingUserInputRequest = {
  readonly requestId: ApprovalRequestId;
  readonly request: ElicitationRequest;
  readonly resolve: (value: ElicitationResult) => void;
  readonly reject: (error: unknown) => void;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
};

type ClaudeSessionState = {
  session: ProviderSession;
  snapshot: {
    threadId: ThreadId;
    turns: Array<ProviderThreadTurnSnapshot>;
  };
  inputQueue: AsyncPushQueue<SDKUserMessage>;
  query: ClaudeQuery;
  abortController: AbortController;
  started: Deferred<void>;
  readerDone: Promise<void>;
  pendingPermissions: Map<ApprovalRequestId, PendingPermissionRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  toolNamesByUseId: Map<string, string>;
  completedToolUseIds: Set<string>;
  activeTurnId: TurnId | null;
  activeAssistantItemId: string | null;
  activeAssistantHasStreamedText: boolean;
  activeAssistantCompleted: boolean;
  currentEffort: ClaudeCodeReasoningEffort | null;
  currentPermissionMode: ClaudePermissionMode;
  binaryPath?: string;
  homePath?: string;
  startupMessageCount: number;
  startupMessageLabels: string[];
  sdkStarted: boolean;
  stopRequested: boolean;
};

export interface ClaudeCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly createQuery?: typeof createClaudeQuery;
}

class AsyncPushQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) {
      throw new Error("AsyncPushQueue is closed");
    }

    const nextResolver = this.resolvers.shift();
    if (nextResolver) {
      nextResolver({ done: false, value });
      return;
    }

    this.values.push(value);
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    while (this.resolvers.length > 0) {
      const nextResolver = this.resolvers.shift();
      nextResolver?.({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const queuedValue = this.values.shift();
        if (queuedValue !== undefined) {
          return Promise.resolve({ done: false, value: queuedValue });
        }
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((nextResolve, nextReject) => {
      resolve = (value) => {
        deferred.settled = true;
        nextResolve(value);
      };
      reject = (error) => {
        deferred.settled = true;
        nextReject(error);
      };
    }),
    resolve: (value) => resolve(value),
    reject: (error) => reject(error),
    settled: false,
  };
  return deferred;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function stringifyJson(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function truncateDetail(value: string | undefined, limit = 240): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3)}...` : trimmed;
}

function permissionModeFromRuntimeMode(
  runtimeMode: ProviderSessionStartInput["runtimeMode"],
  interactionMode?: ProviderSendTurnInput["interactionMode"],
): ClaudePermissionMode {
  if (interactionMode === "plan") {
    return "plan";
  }
  return runtimeMode === "approval-required" ? "default" : "bypassPermissions";
}

function requestTypeForTool(
  toolName: string,
):
  | "exec_command_approval"
  | "file_change_approval"
  | "file_read_approval"
  | "dynamic_tool_call"
  | "unknown" {
  switch (toolName) {
    case "Bash":
      return "exec_command_approval";
    case "Write":
    case "Edit":
    case "MultiEdit":
      return "file_change_approval";
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
      return "file_read_approval";
    case "Task":
    case "Agent":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}

function itemTypeForTool(
  toolName: string,
):
  | "command_execution"
  | "file_change"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view"
  | "unknown" {
  switch (toolName) {
    case "Bash":
      return "command_execution";
    case "Write":
    case "Edit":
    case "MultiEdit":
      return "file_change";
    case "Task":
    case "Agent":
      return "collab_agent_tool_call";
    case "WebFetch":
    case "WebSearch":
      return "web_search";
    case "ViewImage":
      return "image_view";
    default:
      return "dynamic_tool_call";
  }
}

function readClaudeResumeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor;
  }
  if (!isRecord(resumeCursor)) {
    return undefined;
  }
  const direct = asString(resumeCursor.sessionId) ?? asString(resumeCursor.providerSessionId);
  return direct?.trim().length ? direct : undefined;
}

function readClaudeBinaryPath(input: ProviderSessionStartInput): string | undefined {
  const binaryPath = input.providerOptions?.claudeCode?.binaryPath;
  return binaryPath?.trim().length ? binaryPath.trim() : undefined;
}

function readClaudeHomePath(input: ProviderSessionStartInput): string | undefined {
  const homePath = input.providerOptions?.claudeCode?.homePath;
  return homePath?.trim().length ? homePath.trim() : undefined;
}

function readClaudeEffort(
  modelOptions: ProviderSessionStartInput["modelOptions"] | ProviderSendTurnInput["modelOptions"],
): ClaudeCodeReasoningEffort | null {
  const effort = modelOptions?.claudeCode?.effort;
  return effort ?? null;
}

function sdkMessageLabel(message: SDKMessage): string {
  const subtype = "subtype" in message && typeof message.subtype === "string" ? message.subtype : null;
  return subtype ? `${message.type}:${subtype}` : message.type;
}

function recordStartupMessage(state: ClaudeSessionState, message: SDKMessage): void {
  if (state.started.settled) {
    return;
  }

  state.startupMessageCount += 1;
  if (state.startupMessageLabels.length >= STARTUP_MESSAGE_LABEL_LIMIT) {
    return;
  }

  state.startupMessageLabels.push(sdkMessageLabel(message));
}

function formatClaudeStartupTimeoutDetail(state: ClaudeSessionState): string {
  const parts = [
    `Timed out after ${Math.round(START_SESSION_TIMEOUT_MS / 1000)}s while waiting for Claude Code session initialization.`,
  ];

  if (state.session.model) {
    parts.push(`model=${state.session.model}`);
  }
  if (state.currentEffort) {
    parts.push(`effort=${state.currentEffort}`);
  }
  if (state.binaryPath) {
    parts.push(`binary=${state.binaryPath}`);
  }
  if (state.homePath) {
    parts.push(`CLAUDE_CONFIG_DIR=${state.homePath}`);
  }
  const resumeSessionId = readClaudeResumeSessionId(state.session.resumeCursor);
  if (resumeSessionId) {
    parts.push(`resumeSessionId=${resumeSessionId}`);
  }
  if (state.startupMessageCount > 0) {
    const labels = state.startupMessageLabels.join(", ");
    parts.push(
      labels.length > 0
        ? `startupMessages=${labels}${state.startupMessageCount > state.startupMessageLabels.length ? ", ..." : ""}`
        : `startupMessageCount=${state.startupMessageCount}`,
    );
  } else {
    parts.push("no startup messages received from Claude SDK");
  }
  if (state.homePath) {
    parts.push("Verify the configured Claude config directory contains valid Claude auth/config.");
  }

  return parts.join(" ");
}

function buildSdkUserMessage(state: ClaudeSessionState, content: string): SDKUserMessage {
  return {
    type: "user",
    session_id: readClaudeResumeSessionId(state.session.resumeCursor) ?? "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content,
    },
  };
}

function extractAssistantText(message: unknown): string | undefined {
  const messageRecord = isRecord(message) ? message : undefined;
  const content = asArray(messageRecord?.content);
  const textBlocks = content
    .flatMap((entry) => {
      const block = isRecord(entry) ? entry : undefined;
      return block?.type === "text" ? [asString(block.text) ?? ""] : [];
    })
    .join("");

  return truncateDetail(textBlocks.length > 0 ? textBlocks : undefined, 24_000);
}

function extractStreamTextDelta(message: SDKMessage):
  | { streamKind: "assistant_text" | "reasoning_text"; delta: string }
  | null {
  if (message.type !== "stream_event") {
    return null;
  }
  const rawEvent = isRecord(message.event) ? message.event : undefined;
  if (rawEvent?.type !== "content_block_delta") {
    return null;
  }
  const delta = isRecord(rawEvent.delta) ? rawEvent.delta : undefined;
  if (!delta) {
    return null;
  }
  if (delta.type === "text_delta") {
    const text = asString(delta.text);
    return text ? { streamKind: "assistant_text", delta: text } : null;
  }
  if (delta.type === "thinking_delta") {
    const thinking = asString(delta.thinking);
    return thinking ? { streamKind: "reasoning_text", delta: thinking } : null;
  }
  return null;
}

function extractToolUseFromStreamStart(message: SDKMessage): { toolUseId: string; toolName: string } | null {
  if (message.type !== "stream_event") {
    return null;
  }
  const rawEvent = isRecord(message.event) ? message.event : undefined;
  if (rawEvent?.type !== "content_block_start") {
    return null;
  }
  const contentBlock = isRecord(rawEvent.content_block) ? rawEvent.content_block : undefined;
  if (contentBlock?.type !== "tool_use") {
    return null;
  }
  const toolName = asString(contentBlock.name);
  const toolUseId = asString(contentBlock.id) ?? asString(contentBlock.tool_use_id);
  return toolName && toolUseId ? { toolUseId, toolName } : null;
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("abort") || message.includes("cancel") || message.includes("closed");
}

function buildPermissionDetail(input: {
  readonly toolName: string;
  readonly decisionReason?: string;
  readonly blockedPath?: string;
  readonly args?: Record<string, unknown>;
}): string | undefined {
  const detailParts = [
    input.decisionReason,
    input.blockedPath ? `Blocked path: ${input.blockedPath}` : undefined,
    input.args ? stringifyJson(input.args) : undefined,
  ]
    .map((part) => truncateDetail(part))
    .filter((part): part is string => typeof part === "string" && part.length > 0);

  if (detailParts.length === 0) {
    return truncateDetail(`Claude Code requested permission for ${input.toolName}.`);
  }

  return truncateDetail(`${input.toolName}: ${detailParts.join(" • ")}`);
}

function finalizePendingPermissionRequests(state: ClaudeSessionState): void {
  for (const pending of state.pendingPermissions.values()) {
    pending.resolve({
      behavior: "deny",
      message: "Claude Code session closed before the permission request was answered.",
      interrupt: true,
      toolUseID: pending.toolUseId,
    });
  }
  state.pendingPermissions.clear();
}

function finalizePendingUserInputs(state: ClaudeSessionState): void {
  for (const pending of state.pendingUserInputs.values()) {
    pending.resolve({ action: "cancel" });
  }
  state.pendingUserInputs.clear();
}

function buildElicitationQuestions(request: ElicitationRequest) {
  const schema = isRecord(request.requestedSchema) ? request.requestedSchema : undefined;
  const properties = isRecord(schema?.properties) ? schema.properties : undefined;

  if (request.mode === "url") {
    return [
      {
        id: "action",
        header: request.serverName,
        question: truncateDetail(
          [request.message, request.url].filter((part): part is string => Boolean(part)).join("\n\n"),
          4_000,
        ) ?? "Complete the requested Claude Code authentication step.",
        options: [
          {
            label: "Continue",
            description: "I completed the requested step and want to continue.",
          },
          {
            label: "Decline",
            description: "Cancel this Claude Code request.",
          },
        ],
      },
    ] as const;
  }

  if (properties) {
    const questions = Object.entries(properties)
      .map(([key, value]) => {
        const property = isRecord(value) ? value : undefined;
        const title = truncateDetail(asString(property?.title) ?? key, 160);
        const description = truncateDetail(
          asString(property?.description) ?? `Provide a value for ${key}.`,
          1_000,
        );
        const options = asArray(property?.enum)
          .map((option) => asString(option))
          .filter((option): option is string => typeof option === "string" && option.trim().length > 0)
          .map((option) => ({ label: option, description: option }));

        return title && description
          ? {
              id: key,
              header: request.serverName,
              question: description,
              options,
            }
          : null;
      })
      .filter(
        (
          entry,
        ): entry is {
          id: string;
          header: string;
          question: string;
          options: Array<{ label: string; description: string }>;
        } => entry !== null,
      );

    if (questions.length > 0) {
      return questions;
    }
  }

  return [
    {
      id: "response",
      header: request.serverName,
      question:
        truncateDetail(request.message, 4_000) ?? "Claude Code requested additional user input.",
      options: [],
    },
  ] as const;
}

function createRuntimeEvent(input: {
  readonly state: ClaudeSessionState;
  readonly type: ProviderRuntimeEvent["type"];
  readonly payload: unknown;
  readonly rawSource:
    | "claude-code.system"
    | "claude-code.assistant"
    | "claude-code.user"
    | "claude-code.result"
    | "claude-code.stream-event"
    | "claude-code.stderr";
  readonly rawPayload?: unknown;
  readonly messageType?: string;
  readonly turnId?: TurnId | null;
  readonly itemId?: string;
  readonly requestId?: ApprovalRequestId;
}): ProviderRuntimeEvent {
  const resolvedTurnId = input.turnId === null ? undefined : (input.turnId ?? input.state.activeTurnId ?? undefined);
  const providerRefs = {
    ...(input.itemId ? { providerItemId: ProviderItemId.makeUnsafe(input.itemId) } : {}),
    ...(input.requestId ? { providerRequestId: input.requestId } : {}),
  } satisfies NonNullable<ProviderRuntimeEvent["providerRefs"]>;

  return {
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: PROVIDER,
    threadId: input.state.session.threadId,
    createdAt: nowIso(),
    ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
    type: input.type,
    payload: input.payload as never,
    raw: {
      source: input.rawSource,
      ...(input.messageType ? { messageType: input.messageType } : {}),
      payload: input.rawPayload ?? input.payload,
    },
  } as ProviderRuntimeEvent;
}

function updateSession(
  state: ClaudeSessionState,
  patch: Partial<ProviderSession>,
): ProviderSession {
  state.session = {
    ...state.session,
    ...patch,
    updatedAt: nowIso(),
  };
  return state.session;
}

function ensureTurnSnapshot(state: ClaudeSessionState, turnId: TurnId): void {
  const existing = state.snapshot.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return;
  }
  state.snapshot.turns.push({ id: turnId, items: [] });
}

function appendTurnItem(state: ClaudeSessionState, turnId: TurnId, item: unknown): void {
  ensureTurnSnapshot(state, turnId);
  state.snapshot.turns = state.snapshot.turns.map((turn) =>
    turn.id === turnId ? { ...turn, items: [...turn.items, item] } : turn,
  );
}

const makeClaudeCodeAdapter = (options?: ClaudeCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const createQueryImpl = options?.createQuery ?? createClaudeQuery;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const sessions = new Map<ThreadId, ClaudeSessionState>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const writeNativeEvent = async (threadId: ThreadId, event: unknown): Promise<void> => {
      if (!nativeEventLogger) {
        return;
      }
      await Effect.runPromise(nativeEventLogger.write(event, threadId));
    };

    const emitRuntimeEvent = async (event: ProviderRuntimeEvent): Promise<void> => {
      await Effect.runPromise(Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid));
    };

    const completeToolUse = async (
      state: ClaudeSessionState,
      input: {
        toolUseId: string;
        status: "completed" | "failed" | "stopped";
        detail?: string | undefined;
      },
    ) => {
      if (state.completedToolUseIds.has(input.toolUseId)) {
        return;
      }
      state.completedToolUseIds.add(input.toolUseId);
      const toolName = state.toolNamesByUseId.get(input.toolUseId) ?? "Tool";
      await emitRuntimeEvent(
        createRuntimeEvent({
          state,
          type: "item.completed",
          itemId: input.toolUseId,
          rawSource: "claude-code.system",
          messageType: "tool.completed",
          payload: {
            itemType: itemTypeForTool(toolName),
            status:
              input.status === "completed"
                ? "completed"
                : input.status === "failed"
                  ? "failed"
                  : "declined",
            title: toolName,
            ...(input.detail ? { detail: input.detail } : {}),
          },
        }),
      );
    };

    const handleSdkMessage = async (state: ClaudeSessionState, message: SDKMessage): Promise<void> => {
      recordStartupMessage(state, message);
      await writeNativeEvent(state.session.threadId, message);

      if (message.type === "system" && message.subtype === "init") {
        const resumeCursor = { sessionId: message.session_id };
        updateSession(state, {
          status: "ready",
          model: normalizeModelSlug(message.model, PROVIDER) ?? message.model,
          cwd: message.cwd,
          resumeCursor,
          lastError: undefined,
        });
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "session.started",
            rawSource: "claude-code.system",
            messageType: "init",
            payload: {
              message: "Claude Code session started",
              resume: resumeCursor,
            },
            rawPayload: message,
            turnId: null,
          }),
        );
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "session.configured",
            rawSource: "claude-code.system",
            messageType: "init",
            payload: {
              config: {
                model: message.model,
                cwd: message.cwd,
                permissionMode: message.permissionMode,
                claudeCodeVersion: message.claude_code_version,
                tools: message.tools,
                mcpServers: message.mcp_servers,
                slashCommands: message.slash_commands,
                skills: message.skills,
              },
            },
            rawPayload: message,
            turnId: null,
          }),
        );
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "thread.started",
            rawSource: "claude-code.system",
            messageType: "init",
            payload: {
              providerThreadId: message.session_id,
            },
            rawPayload: message,
            turnId: null,
          }),
        );
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "account.updated",
            rawSource: "claude-code.system",
            messageType: "init",
            payload: {
              account: {
                apiKeySource: message.apiKeySource,
                fastModeState: message.fast_mode_state ?? null,
              },
            },
            rawPayload: message,
            turnId: null,
          }),
        );
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "mcp.status.updated",
            rawSource: "claude-code.system",
            messageType: "init",
            payload: {
              status: message.mcp_servers,
            },
            rawPayload: message,
            turnId: null,
          }),
        );
        if (!state.started.settled) {
          state.started.resolve(undefined);
        }
        return;
      }

      if (message.type === "auth_status") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "auth.status",
            rawSource: "claude-code.system",
            messageType: "auth_status",
            payload: {
              isAuthenticating: message.isAuthenticating,
              output: message.output,
              ...(message.error ? { error: message.error } : {}),
            },
            rawPayload: message,
            turnId: null,
          }),
        );
        return;
      }

      if (message.type === "rate_limit_event") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "account.rate-limits.updated",
            rawSource: "claude-code.system",
            messageType: "rate_limit_event",
            payload: {
              rateLimits: message.rate_limit_info,
            },
            rawPayload: message,
            turnId: null,
          }),
        );
        return;
      }

      if (message.type === "system" && message.subtype === "files_persisted") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "files.persisted",
            rawSource: "claude-code.system",
            messageType: "files_persisted",
            payload: {
              files: message.files,
              failed: message.failed.length > 0 ? message.failed : undefined,
            },
            rawPayload: message,
          }),
        );
        return;
      }

      if (message.type === "system" && message.subtype === "hook_started") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "hook.started",
            rawSource: "claude-code.system",
            messageType: "hook_started",
            payload: {
              hookId: message.hook_id,
              hookName: message.hook_name,
              hookEvent: message.hook_event,
            },
            rawPayload: message,
          }),
        );
        return;
      }

      if (message.type === "system" && message.subtype === "hook_progress") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "hook.progress",
            rawSource: "claude-code.system",
            messageType: "hook_progress",
            payload: {
              hookId: message.hook_id,
              output: message.output,
              stdout: message.stdout,
              stderr: message.stderr,
            },
            rawPayload: message,
          }),
        );
        return;
      }

      if (message.type === "system" && message.subtype === "hook_response") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "hook.completed",
            rawSource: "claude-code.system",
            messageType: "hook_response",
            payload: {
              hookId: message.hook_id,
              outcome: message.outcome,
              output: message.output,
              stdout: message.stdout,
              stderr: message.stderr,
              ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
            },
            rawPayload: message,
          }),
        );
        return;
      }

      if (message.type === "tool_progress") {
        state.toolNamesByUseId.set(message.tool_use_id, message.tool_name);
        if (!state.completedToolUseIds.has(message.tool_use_id)) {
          await emitRuntimeEvent(
            createRuntimeEvent({
              state,
              type: "item.started",
              itemId: message.tool_use_id,
              rawSource: "claude-code.system",
              messageType: "tool_progress",
              payload: {
                itemType: itemTypeForTool(message.tool_name),
                status: "inProgress",
                title: message.tool_name,
              },
              rawPayload: message,
            }),
          );
        }
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "tool.progress",
            itemId: message.tool_use_id,
            rawSource: "claude-code.system",
            messageType: "tool_progress",
            payload: {
              toolUseId: message.tool_use_id,
              toolName: message.tool_name,
              elapsedSeconds: message.elapsed_time_seconds,
            },
            rawPayload: message,
          }),
        );
        return;
      }

      if (message.type === "tool_use_summary") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "tool.summary",
            rawSource: "claude-code.system",
            messageType: "tool_use_summary",
            payload: {
              summary: message.summary,
              precedingToolUseIds: message.preceding_tool_use_ids,
            },
            rawPayload: message,
          }),
        );
        await Promise.all(
          message.preceding_tool_use_ids.map((toolUseId) =>
            completeToolUse(state, {
              toolUseId,
              status: "completed",
              ...(truncateDetail(message.summary) ? { detail: truncateDetail(message.summary)! } : {}),
            }),
          ),
        );
        return;
      }

      if (message.type === "system" && message.subtype === "task_started") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "task.started",
            rawSource: "claude-code.system",
            messageType: "task_started",
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(message.task_id),
              ...(message.description ? { description: message.description } : {}),
              ...(message.task_type ? { taskType: message.task_type } : {}),
            },
            rawPayload: message,
          }),
        );
        return;
      }

      if (message.type === "system" && message.subtype === "task_progress") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "task.progress",
            rawSource: "claude-code.system",
            messageType: "task_progress",
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(message.task_id),
              description: message.description,
              usage: message.usage,
              ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            },
            rawPayload: message,
          }),
        );
        return;
      }

      if (message.type === "system" && message.subtype === "task_notification") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "task.completed",
            rawSource: "claude-code.system",
            messageType: "task_notification",
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(message.task_id),
              status: message.status,
              ...(message.summary ? { summary: message.summary } : {}),
              ...(message.usage ? { usage: message.usage } : {}),
            },
            rawPayload: message,
          }),
        );
        if (message.tool_use_id) {
          await completeToolUse(state, {
            toolUseId: message.tool_use_id,
            status: message.status,
            ...(truncateDetail(message.summary) ? { detail: truncateDetail(message.summary)! } : {}),
          });
        }
        return;
      }

      if (message.type === "system" && message.subtype === "local_command_output") {
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "item.completed",
            itemId: message.uuid,
            rawSource: "claude-code.system",
            messageType: "local_command_output",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              ...(truncateDetail(message.content, 24_000) ? { detail: truncateDetail(message.content, 24_000)! } : {}),
              data: message,
            },
            rawPayload: message,
          }),
        );
        return;
      }

      if (message.type === "system" && message.subtype === "status") {
        state.currentPermissionMode = message.permissionMode ?? state.currentPermissionMode;
        return;
      }

      if (state.activeTurnId === null) {
        return;
      }

      const streamDelta = extractStreamTextDelta(message);
      if (streamDelta) {
        state.activeAssistantItemId =
          state.activeAssistantItemId ?? message.uuid ?? `assistant:${String(state.activeTurnId)}`;
        state.activeAssistantHasStreamedText = true;
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "content.delta",
            itemId: state.activeAssistantItemId,
            rawSource: "claude-code.stream-event",
            messageType: "content_block_delta",
            payload: {
              streamKind: streamDelta.streamKind,
              delta: streamDelta.delta,
            },
            rawPayload: message,
          }),
        );
        return;
      }

      const toolStart = extractToolUseFromStreamStart(message);
      if (toolStart) {
        state.toolNamesByUseId.set(toolStart.toolUseId, toolStart.toolName);
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "item.started",
            itemId: toolStart.toolUseId,
            rawSource: "claude-code.stream-event",
            messageType: "content_block_start",
            payload: {
              itemType: itemTypeForTool(toolStart.toolName),
              status: "inProgress",
              title: toolStart.toolName,
              data: message,
            },
            rawPayload: message,
          }),
        );
        appendTurnItem(state, state.activeTurnId, {
          type: "tool.started",
          toolUseId: toolStart.toolUseId,
          toolName: toolStart.toolName,
        });
        return;
      }

      if (message.type === "assistant") {
        state.activeAssistantItemId =
          state.activeAssistantItemId ?? message.uuid ?? `assistant:${String(state.activeTurnId)}`;
        const assistantText = extractAssistantText(message.message);
        if (state.activeAssistantHasStreamedText) {
          appendTurnItem(state, state.activeTurnId, {
            type: "assistant.completed",
            itemId: state.activeAssistantItemId,
            text: assistantText,
          });
          state.activeAssistantCompleted = true;
          return;
        }
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "item.completed",
            itemId: state.activeAssistantItemId,
            rawSource: "claude-code.assistant",
            messageType: "assistant",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              ...(assistantText ? { detail: assistantText } : {}),
              data: message.message,
            },
            rawPayload: message,
          }),
        );
        appendTurnItem(state, state.activeTurnId, {
          type: "assistant.completed",
          itemId: state.activeAssistantItemId,
          text: assistantText,
        });
        state.activeAssistantCompleted = true;
        return;
      }

      if (message.type === "result") {
        const turnId = state.activeTurnId;
        const turnState = message.is_error ? "failed" : "completed";
        const errorMessage =
          message.is_error && "errors" in message
            ? truncateDetail(message.errors[0], 1_000)
            : undefined;
        const assistantItemId = state.activeAssistantItemId ?? `assistant:${String(turnId)}`;

        if (
          !state.activeAssistantCompleted &&
          !state.activeAssistantHasStreamedText &&
          !message.is_error &&
          "result" in message &&
          typeof message.result === "string" &&
          message.result.trim().length > 0
        ) {
          await emitRuntimeEvent(
            createRuntimeEvent({
              state,
              type: "item.completed",
              itemId: assistantItemId,
              rawSource: "claude-code.result",
              messageType: "result",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                ...(truncateDetail(message.result, 24_000) ? { detail: truncateDetail(message.result, 24_000)! } : {}),
              },
              rawPayload: message,
              turnId,
            }),
          );
          state.activeAssistantCompleted = true;
        }

        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "turn.completed",
            rawSource: "claude-code.result",
            messageType: `result.${message.subtype}`,
            payload: {
              state: turnState,
              stopReason: message.stop_reason,
              usage: message.usage,
              modelUsage: message.modelUsage,
              totalCostUsd: message.total_cost_usd,
              ...(errorMessage ? { errorMessage } : {}),
            },
            rawPayload: message,
            turnId,
          }),
        );

        updateSession(state, {
          status: message.is_error ? "error" : "ready",
          activeTurnId: undefined,
          ...(errorMessage ? { lastError: errorMessage } : { lastError: undefined }),
        });
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "session.state.changed",
            rawSource: "claude-code.result",
            messageType: `result.${message.subtype}`,
            payload: {
              state: message.is_error ? "error" : "ready",
              ...(errorMessage ? { reason: errorMessage } : {}),
              detail: message,
            },
            rawPayload: message,
            turnId: null,
          }),
        );

        state.activeTurnId = null;
        state.activeAssistantItemId = null;
        state.completedToolUseIds.clear();
        return;
      }
    };

    const createPermissionHandler = (
      state: ClaudeSessionState,
    ) => async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: unknown[];
        blockedPath?: string;
        decisionReason?: string;
        toolUseID: string;
      },
    ): Promise<PermissionResult> => {
      const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
        const detail = buildPermissionDetail({
          toolName,
          ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
          ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
          ...(Object.keys(input).length > 0 ? { args: input } : {}),
        });

      await emitRuntimeEvent(
        createRuntimeEvent({
          state,
          type: "request.opened",
          requestId,
          rawSource: "claude-code.system",
          messageType: "permission.request",
          payload: {
            requestType: requestTypeForTool(toolName),
            ...(detail ? { detail } : {}),
            args: {
              toolName,
              input,
              ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
              ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
            },
          },
          rawPayload: {
            toolName,
            input,
            toolUseID: options.toolUseID,
            blockedPath: options.blockedPath,
            decisionReason: options.decisionReason,
          },
        }),
      );

      return await new Promise<PermissionResult>((resolve, reject) => {
        const onAbort = () => {
          state.pendingPermissions.delete(requestId);
          resolve({
            behavior: "deny",
            message: "Claude Code permission request was cancelled.",
            interrupt: true,
            toolUseID: options.toolUseID,
          });
        };
        options.signal.addEventListener("abort", onAbort, { once: true });

        state.pendingPermissions.set(requestId, {
          requestId,
          toolName,
          toolUseId: options.toolUseID,
          ...(detail ? { detail } : {}),
          args: input,
          ...(options.suggestions ? { suggestions: options.suggestions } : {}),
          resolve: (result) => {
            options.signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
          reject: (error) => {
            options.signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        });
      });
    };

    const createElicitationHandler =
      (state: ClaudeSessionState) =>
      async (request: ElicitationRequest): Promise<ElicitationResult> => {
        const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "user-input.requested",
            requestId,
            rawSource: "claude-code.system",
            messageType: "elicitation.request",
            payload: {
              questions: buildElicitationQuestions(request),
            },
            rawPayload: request,
          }),
        );

        return await new Promise<ElicitationResult>((resolve, reject) => {
          state.pendingUserInputs.set(requestId, {
            requestId,
            request,
            resolve,
            reject,
          });
        });
      };

    const startSdkSession = async (
      state: ClaudeSessionState,
      input: { resumeSessionId?: string; initialUserMessage?: SDKUserMessage },
    ) => {
      const inputQueue = new AsyncPushQueue<SDKUserMessage>();
      const abortController = new AbortController();
      const cwd = state.session.cwd;
      const model = state.session.model;
      const binaryPath = state.binaryPath;
      const homePath = state.homePath;
      const resumeSessionId = input.resumeSessionId;
      const query = createQueryImpl({
        prompt: inputQueue,
        options: {
          abortController,
          ...(typeof cwd === "string" && cwd.length > 0 ? { cwd } : {}),
          ...(typeof model === "string" && model.length > 0 ? { model } : {}),
          ...(typeof binaryPath === "string" && binaryPath.length > 0
            ? { pathToClaudeCodeExecutable: binaryPath }
            : {}),
          ...(typeof homePath === "string" && homePath.length > 0
            ? { env: { ...process.env, CLAUDE_CONFIG_DIR: homePath } }
            : {}),
          ...(typeof resumeSessionId === "string" && resumeSessionId.length > 0
            ? { resume: resumeSessionId }
            : {}),
          ...(state.currentEffort ? { effort: state.currentEffort } : {}),
          permissionMode: state.currentPermissionMode,
          ...(state.currentPermissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          includePartialMessages: true,
          persistSession: true,
          canUseTool: createPermissionHandler(state),
          onElicitation: createElicitationHandler(state),
        },
      });

      state.inputQueue = inputQueue;
      state.abortController = abortController;
      state.query = query;
      state.started = createDeferred<void>();
      state.sdkStarted = true;
      state.readerDone = (async () => {
        try {
          for await (const message of query) {
            await handleSdkMessage(state, message);
          }
          if (!state.stopRequested) {
            updateSession(state, {
              status: "closed",
              activeTurnId: undefined,
            });
            await emitRuntimeEvent(
              createRuntimeEvent({
                state,
                type: "session.exited",
                rawSource: "claude-code.system",
                messageType: "session.exited",
                payload: {
                  reason: "Claude Code session ended.",
                  recoverable: true,
                  exitKind: "graceful",
                },
                rawPayload: {
                  reason: "session-ended",
                },
                turnId: null,
              }),
            );
          }
        } catch (error) {
          if (!state.stopRequested && !isAbortLikeError(error)) {
            const detail = toMessage(error, "Claude Code session terminated unexpectedly.");
            updateSession(state, {
              status: "error",
              activeTurnId: undefined,
              lastError: detail,
            });
            await emitRuntimeEvent(
              createRuntimeEvent({
                state,
                type: "runtime.error",
                rawSource: "claude-code.stderr",
                messageType: "session.error",
                payload: {
                  message: detail,
                  class: "provider_error" satisfies RuntimeErrorClass,
                  detail: error,
                },
                rawPayload: {
                  error: detail,
                },
                turnId: null,
              }),
            );
            await emitRuntimeEvent(
              createRuntimeEvent({
                state,
                type: "session.exited",
                rawSource: "claude-code.stderr",
                messageType: "session.error",
                payload: {
                  reason: detail,
                  recoverable: true,
                  exitKind: "error",
                },
                rawPayload: {
                  error: detail,
                },
                turnId: null,
              }),
            );
            if (!state.started.settled) {
              state.started.reject(error);
            }
          }
        } finally {
          finalizePendingPermissionRequests(state);
          finalizePendingUserInputs(state);
          if (!state.started.settled) {
            state.started.resolve(undefined);
          }
        }
      })();

      if (input.initialUserMessage) {
        state.inputQueue.push(input.initialUserMessage);
      }

      await Promise.race([
        state.started.promise,
        new Promise<void>((_, reject) => {
          const timeout = setTimeout(() => {
            clearTimeout(timeout);
            reject(new Error(formatClaudeStartupTimeoutDetail(state)));
          }, START_SESSION_TIMEOUT_MS);
        }),
      ]);
    };

    const stopSdkSession = async (state: ClaudeSessionState) => {
      if (!state.sdkStarted) {
        updateSession(state, {
          status: "closed",
          activeTurnId: undefined,
        });
        return;
      }

      state.stopRequested = true;
      state.inputQueue.end();
      try {
        await state.query.interrupt();
      } catch {
        // Best effort.
      }
      state.abortController.abort();
      finalizePendingPermissionRequests(state);
      finalizePendingUserInputs(state);
      try {
        await state.readerDone;
      } catch {
        // Reader shutdown is best effort.
      }
      updateSession(state, {
        status: "closed",
        activeTurnId: undefined,
      });
      state.sdkStarted = false;
    };

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
      Effect.promise(async () => {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing) {
          await stopSdkSession(existing);
          sessions.delete(input.threadId);
        }

        const normalizedModel = normalizeModelSlug(input.model, PROVIDER) ?? input.model;
        const createdAt = nowIso();
        const binaryPath = readClaudeBinaryPath(input);
        const homePath = readClaudeHomePath(input);
        const binaryPathFields =
          typeof binaryPath === "string" && binaryPath.length > 0 ? { binaryPath } : {};
        const homePathFields =
          typeof homePath === "string" && homePath.length > 0 ? { homePath } : {};
        const state = {
          session: {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
            createdAt,
            updatedAt: createdAt,
          },
          snapshot: {
            threadId: input.threadId,
            turns: [],
          },
          inputQueue: new AsyncPushQueue<SDKUserMessage>(),
          query: null as unknown as ClaudeQuery,
          abortController: new AbortController(),
          started: createDeferred<void>(),
          readerDone: Promise.resolve(),
          pendingPermissions: new Map(),
          pendingUserInputs: new Map(),
          toolNamesByUseId: new Map(),
          completedToolUseIds: new Set(),
          activeTurnId: null,
          activeAssistantItemId: null,
          activeAssistantHasStreamedText: false,
          activeAssistantCompleted: false,
          currentEffort: readClaudeEffort(input.modelOptions),
          currentPermissionMode: permissionModeFromRuntimeMode(input.runtimeMode),
          ...binaryPathFields,
          ...homePathFields,
          startupMessageCount: 0,
          startupMessageLabels: [],
          sdkStarted: false,
          stopRequested: false,
        } satisfies ClaudeSessionState;

        sessions.set(input.threadId, state);

        return state.session;
      });

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.promise(async () => {
        const state = sessions.get(input.threadId);
        if (!state) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        if (input.attachments && input.attachments.length > 0) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Claude Code image inputs are not wired yet in this adapter.",
          });
        }

        if (state.activeTurnId) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: "Claude Code already has an active turn for this thread.",
          });
        }

        const desiredPermissionMode = permissionModeFromRuntimeMode(
          state.session.runtimeMode,
          input.interactionMode,
        );
        const desiredEffort = readClaudeEffort(input.modelOptions) ?? state.currentEffort;
        const trimmedInput = input.input?.trim();
        const content = trimmedInput && trimmedInput.length > 0 ? trimmedInput : "Continue.";
        const turnId = TurnId.makeUnsafe(randomUUID());
        state.activeTurnId = turnId;
        state.activeAssistantItemId = null;
        state.activeAssistantHasStreamedText = false;
        state.activeAssistantCompleted = false;
        state.completedToolUseIds.clear();
        state.toolNamesByUseId.clear();
        ensureTurnSnapshot(state, turnId);
        const initialUserMessage = buildSdkUserMessage(state, content);
        let queuedOnSessionStart = false;

        if (!state.sdkStarted) {
          const resumeSessionId = readClaudeResumeSessionId(state.session.resumeCursor);
          updateSession(state, {
            status: "connecting",
            lastError: undefined,
          });
          queuedOnSessionStart = true;
          await startSdkSession(
            state,
            resumeSessionId
              ? { resumeSessionId, initialUserMessage }
              : { initialUserMessage },
          );
        }

        if (desiredEffort !== state.currentEffort) {
          const resumeSessionId = readClaudeResumeSessionId(state.session.resumeCursor);
          await stopSdkSession(state);
          state.stopRequested = false;
          state.currentEffort = desiredEffort;
          updateSession(state, {
            status: "connecting",
            lastError: undefined,
          });
          queuedOnSessionStart = true;
          await startSdkSession(
            state,
            resumeSessionId
              ? { resumeSessionId, initialUserMessage }
              : { initialUserMessage },
          );
        }
        if (desiredPermissionMode !== state.currentPermissionMode) {
          await state.query.setPermissionMode(desiredPermissionMode);
          state.currentPermissionMode = desiredPermissionMode;
        }
        updateSession(state, {
          status: "running",
          activeTurnId: turnId,
          ...(normalizeModelSlug(input.model, PROVIDER) ?? input.model
            ? { model: normalizeModelSlug(input.model, PROVIDER) ?? input.model }
            : {}),
          lastError: undefined,
        });

        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "session.state.changed",
            rawSource: "claude-code.user",
            messageType: "turn.start",
            payload: {
              state: "running",
            },
            rawPayload: input,
            turnId: null,
          }),
        );
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "turn.started",
            rawSource: "claude-code.user",
            messageType: "turn.start",
            payload: {
              model: state.session.model,
            },
            rawPayload: input,
            turnId,
          }),
        );

        if (!queuedOnSessionStart && state.sdkStarted && state.started.settled) {
          state.inputQueue.push(initialUserMessage);
        }
        appendTurnItem(state, turnId, {
          type: "user",
          input: content,
        });

        return {
          threadId: input.threadId,
          turnId,
          ...(state.session.resumeCursor !== undefined
            ? { resumeCursor: state.session.resumeCursor }
            : {}),
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.promise(async () => {
        const state = sessions.get(threadId);
        if (!state) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        try {
          await state.query.interrupt();
        } catch (error) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/interrupt",
            detail: toMessage(error, "Failed to interrupt Claude Code turn."),
            cause: error,
          });
        }
      });

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.promise(async () => {
        const state = sessions.get(threadId);
        if (!state) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        const pending = state.pendingPermissions.get(requestId);
        if (!pending) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission/respond",
            detail: UNKNOWN_PENDING_APPROVAL_REQUEST,
          });
        }

        state.pendingPermissions.delete(requestId);
        const permissionResult: PermissionResult = (() => {
          switch (decision) {
            case "acceptForSession":
              return {
                behavior: "allow",
                ...(pending.suggestions && pending.suggestions.length > 0
                  ? { updatedPermissions: pending.suggestions as never }
                  : {}),
                toolUseID: pending.toolUseId,
              };
            case "decline":
              return {
                behavior: "deny",
                message: "Denied by user.",
                toolUseID: pending.toolUseId,
              };
            case "cancel":
              return {
                behavior: "deny",
                message: "Cancelled by user.",
                interrupt: true,
                toolUseID: pending.toolUseId,
              };
            case "accept":
            default:
              return {
                behavior: "allow",
                toolUseID: pending.toolUseId,
              };
          }
        })();

        pending.resolve(permissionResult);
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "request.resolved",
            requestId,
            rawSource: "claude-code.system",
            messageType: "permission.response",
            payload: {
              requestType: requestTypeForTool(pending.toolName),
              decision,
              resolution: {
                toolName: pending.toolName,
                toolUseId: pending.toolUseId,
              },
            },
            rawPayload: {
              toolName: pending.toolName,
              decision,
            },
          }),
        );
      });

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.promise(async () => {
        const state = sessions.get(threadId);
        if (!state) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        const pending = state.pendingUserInputs.get(requestId);
        if (!pending) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input/respond",
            detail: UNKNOWN_PENDING_USER_INPUT_REQUEST,
          });
        }

        state.pendingUserInputs.delete(requestId);
        const actionAnswer = asString(answers.action) ?? asString(answers.response);
        const loweredAction = actionAnswer?.trim().toLowerCase();
        const response: ElicitationResult =
          pending.request.mode === "url"
            ? loweredAction === "decline"
              ? { action: "decline" }
              : loweredAction === "cancel"
                ? { action: "cancel" }
                : { action: "accept" }
            : {
                action: "accept",
                content: answers,
              };

        pending.resolve(response);
        await emitRuntimeEvent(
          createRuntimeEvent({
            state,
            type: "user-input.resolved",
            requestId,
            rawSource: "claude-code.system",
            messageType: "elicitation.response",
            payload: {
              answers,
            },
            rawPayload: {
              request: pending.request,
              answers,
            },
          }),
        );
      });

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.promise(async () => {
        const state = sessions.get(threadId);
        if (!state) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        sessions.delete(threadId);
        await stopSdkSession(state);
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (state) => state.session));

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.flatMap((state) =>
          state
            ? Effect.succeed(state.snapshot)
            : Effect.fail(
                new ProviderAdapterSessionNotFoundError({
                  provider: PROVIDER,
                  threadId,
                }),
              ),
        ),
      );

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (_threadId) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Claude Code conversation rollback is not supported yet.",
        }),
      );

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.promise(async () => {
        const activeSessions = Array.from(sessions.values());
        sessions.clear();
        await Promise.all(activeSessions.map((state) => stopSdkSession(state)));
      });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: PROVIDER_CAPABILITIES_BY_PROVIDER.claudeCode,
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
    } satisfies ClaudeCodeAdapterShape;
  });

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}
