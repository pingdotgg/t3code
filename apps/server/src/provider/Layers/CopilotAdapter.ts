import { randomUUID } from "node:crypto";

import {
  type CodexReasoningEffort,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
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
  updatedAt: string;
  lastError: string | undefined;
  toolTitlesByCallId: Map<string, string>;
  pendingApprovalResolvers: Map<string, PendingApprovalRequest>;
  pendingUserInputResolvers: Map<string, PendingUserInputRequest>;
  unsubscribe: () => void;
}

interface CopilotSessionHandle {
  readonly sessionId: string;
  destroy(): Promise<void>;
  on(handler: (event: SessionEvent) => void): () => void;
  send(options: { prompt: string; attachments?: unknown; mode?: string }): Promise<string>;
  abort(): Promise<void>;
  getMessages(): Promise<SessionEvent[]>;
}

interface CopilotClientHandle {
  start(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  createSession(config: Parameters<CopilotClient["createSession"]>[0]): Promise<CopilotSessionHandle>;
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

function mapSupportedModelsById(models: ReadonlyArray<ModelInfo>) {
  return new Map(models.map((model) => [model.id, model]));
}

function getCopilotReasoningEffort(
  modelOptions: unknown,
) {
  const record = asRecord(modelOptions);
  const copilot = asRecord(record?.copilot);
  const reasoningEffort = normalizeString(copilot?.reasoningEffort);
  return reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high" ||
    reasoningEffort === "xhigh"
    ? reasoningEffort
    : undefined;
}

function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor.trim();
  }
  const record = asRecord(resumeCursor);
  const sessionId = normalizeString(record?.sessionId);
  return sessionId;
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
    case "mcp":
    case "custom-tool":
      return "dynamic_tool_call" as const;
    default:
      return "unknown" as const;
  }
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
  return event.data.mcpToolName ? "mcp_tool_call" : "dynamic_tool_call";
}

function toolDetailFromEvent(data: {
  readonly toolName?: string;
  readonly mcpToolName?: string;
  readonly mcpServerName?: string;
}) {
  return trimToUndefined(
    [data.mcpServerName, data.mcpToolName ?? data.toolName].filter(Boolean).join(" / "),
  );
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
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = trimToUndefined(input.requestId);
  return {
    eventId: input.eventId,
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
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

function mapHistoryToTurns(threadId: ThreadId, events: ReadonlyArray<SessionEvent>): ProviderThreadSnapshot {
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
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    currentTurnId: undefined,
    currentProviderTurnId: undefined,
    pendingCompletionTurnId: undefined,
    pendingCompletionProviderTurnId: undefined,
    pendingTurnIds: [],
    pendingTurnUsage: undefined,
    toolTitlesByCallId: new Map(),
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
      Effect.runPromise(Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid)).catch(() => undefined);

    const writeNativeEvent = (threadId: ThreadId, event: SessionEvent) => {
      if (!nativeEventLogger) return Promise.resolve();
      return Effect.runPromise(nativeEventLogger.write(event, threadId)).catch(() => undefined);
    };

    const mapSessionEvent = (
      record: ActiveCopilotSession,
      event: SessionEvent,
    ): ReadonlyArray<ProviderRuntimeEvent> => {
      const currentTurnId = record.currentTurnId;
      const currentProviderTurnId = record.currentProviderTurnId;
      const resolveOrchestrationTurnId = (providerTurnId: TurnId | undefined): TurnId | undefined => {
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
        case "session.usage_info":
          return [
            {
              ...base(),
              type: "thread.token-usage.updated",
              payload: {
                usage: event.data,
              },
            },
          ];
        case "session.task_complete":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId: toRuntimeTaskId(record.threadId) ?? RuntimeTaskId.makeUnsafe(record.threadId),
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
          const completionRefs = completionTurnRefs(record);
          const completionBase =
            completionRefs.turnId || completionRefs.providerTurnId ? base(completionRefs) : base();
          return [
            {
              ...completionBase,
              type: "thread.token-usage.updated",
              payload: {
                usage: event.data,
              },
            },
          ];
        }
        case "abort": {
          const abortedTurnRefs = completionTurnRefs(record);
          const abortedBase =
            abortedTurnRefs.turnId || abortedTurnRefs.providerTurnId ? base(abortedTurnRefs) : base();
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
        case "tool.execution_start":
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "item.started",
              payload: {
                itemType: itemTypeFromToolEvent(event),
                status: "inProgress",
                title: event.data.toolName ?? "Tool call",
                ...(toolDetailFromEvent(event.data) ? { detail: toolDetailFromEvent(event.data) } : {}),
                data: event.data,
              },
            },
          ];
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
        case "tool.execution_complete":
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "item.completed",
              payload: {
                itemType: event.data.result?.contents?.some((content) => content.type === "terminal")
                  ? "command_execution"
                  : "dynamic_tool_call",
                status: event.data.success ? "completed" : "failed",
                title: record.toolTitlesByCallId.get(event.data.toolCallId) ?? "Tool call",
                ...(trimToUndefined(event.data.result?.content) ? { detail: event.data.result?.content } : {}),
                data: event.data,
              },
            },
            ...(trimToUndefined(event.data.result?.content)
              ? [
                  {
                    ...base({ itemId: event.data.toolCallId }),
                    type: "tool.summary" as const,
                    payload: {
                      summary: event.data.result?.content ?? "",
                      precedingToolUseIds: [event.data.toolCallId],
                    },
                  },
                ]
              : []),
          ];
        case "skill.invoked":
          return [
            {
              ...base(),
              type: "task.progress",
              payload: {
                taskId: toRuntimeTaskId(event.data.name) ?? RuntimeTaskId.makeUnsafe(event.data.name),
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
                  toRuntimeTaskId(event.data.toolCallId) ?? RuntimeTaskId.makeUnsafe(event.data.toolCallId),
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
                  toRuntimeTaskId(event.data.toolCallId) ?? RuntimeTaskId.makeUnsafe(event.data.toolCallId),
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
                  toRuntimeTaskId(event.data.toolCallId) ?? RuntimeTaskId.makeUnsafe(event.data.toolCallId),
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
          :
        new Promise<PermissionRequestResult>((resolve) => {
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
            issue: "GitHub Copilot reasoning effort requires an explicit supported model selection.",
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
          const sessionId = record.session.sessionId;
          const previousSession = record.session;
          const previousUnsubscribe = record.unsubscribe;
          previousUnsubscribe();
          await previousSession.destroy();

          const handlers = createInteractionHandlers(
            record.threadId,
            () => record.currentTurnId,
            () => record.runtimeMode,
            record.pendingApprovalResolvers,
            record.pendingUserInputResolvers,
          );
          const nextSession = await record.client.resumeSession(sessionId, {
            ...handlers,
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            ...(record.cwd ? { workingDirectory: record.cwd } : {}),
            ...(record.configDir ? { configDir: record.configDir } : {}),
            streaming: true,
          });

          record.session = nextSession;
          record.model = input.model;
          record.reasoningEffort = input.reasoningEffort;
          record.updatedAt = new Date().toISOString();
          record.unsubscribe = nextSession.on((event) => {
            handleSessionEvent(record, event);
          });
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.reconfigure",
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
      if (event.type === "tool.execution_start" && trimToUndefined(event.data.toolName)) {
        record.toolTitlesByCallId.set(event.data.toolCallId, trimToUndefined(event.data.toolName)!);
      }

      void writeNativeEvent(record.threadId, event);
      const runtimeEvents = mapSessionEvent(record, event);
      if (runtimeEvents.length > 0) {
        void emitRuntimeEvents(runtimeEvents);
      }
      if (event.type === "tool.execution_complete") {
        record.toolTitlesByCallId.delete(event.data.toolCallId);
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
        return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
      }
      return Effect.succeed(record);
    };

    const stopRecord = async (record: ActiveCopilotSession) => {
      record.unsubscribe();
      try {
        await record.session.destroy();
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
      for (const pending of record.pendingUserInputResolvers.values()) {
        pending.resolve({ answer: "", wasFreeform: true });
      }
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
        const reasoningEffort = getCopilotReasoningEffort(input.modelOptions);
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
          model: input.model,
          reasoningEffort,
        });

        const session = yield* Effect.tryPromise({
          try: async () => {
            if (resumeSessionId) {
              return client.resumeSession(resumeSessionId, {
                ...handlers,
                ...(input.model ? { model: input.model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
                ...(input.cwd ? { workingDirectory: input.cwd } : {}),
                ...(configDir ? { configDir } : {}),
                streaming: true,
              });
            }
            return client.createSession({
              ...handlers,
              ...(input.model ? { model: input.model } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
              ...(input.cwd ? { workingDirectory: input.cwd } : {}),
              ...(configDir ? { configDir } : {}),
              streaming: true,
            });
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
          model: input.model,
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
              ...(input.model ? { model: input.model } : {}),
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
          ...(input.model ? { model: input.model } : {}),
          threadId: input.threadId,
          resumeCursor: session.sessionId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        } satisfies ProviderSession;
      });

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(input.threadId);
        const explicitReasoningEffort = getCopilotReasoningEffort(input.modelOptions);
        const nextModel = input.model ?? record.model;
        const nextReasoningEffort =
          explicitReasoningEffort !== undefined
            ? explicitReasoningEffort
            : input.model && input.model !== record.model
              ? undefined
              : record.reasoningEffort;
        const attachments = (input.attachments ?? [])
          .map((attachment) => {
            const attachmentPath = resolveAttachmentPath({
              stateDir: serverConfig.stateDir,
              attachment,
            });
            if (!attachmentPath) {
              throw new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.send",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            return {
              type: "file" as const,
              path: attachmentPath,
              displayName: attachment.name,
            };
          });

        yield* validateSessionConfiguration({
          client: record.client,
          threadId: input.threadId,
          model: nextModel,
          reasoningEffort: nextReasoningEffort,
        });

        if (nextModel !== record.model || nextReasoningEffort !== record.reasoningEffort) {
          yield* reconfigureSession(record, {
            model: nextModel,
            reasoningEffort: nextReasoningEffort,
          });
        }

        const turnId = TurnId.makeUnsafe(`copilot-turn-${randomUUID()}`);
        record.pendingTurnIds.push(turnId);
        record.currentTurnId = turnId;
        record.currentProviderTurnId = undefined;

        yield* Effect.tryPromise({
          try: () =>
            record.session.send({
              prompt: input.input ?? "",
              ...(attachments.length > 0 ? { attachments } : {}),
              mode: "immediate",
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
              record.pendingTurnIds = record.pendingTurnIds.filter((candidate) => candidate !== turnId);
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
        Array.from(sessions.values()).map(
          (record) =>
            ({
              provider: PROVIDER,
              status: record.currentTurnId ? "running" : "ready",
              runtimeMode: record.runtimeMode,
              threadId: record.threadId,
              resumeCursor: record.session.sessionId,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              ...(record.cwd ? { cwd: record.cwd } : {}),
              ...(record.model ? { model: record.model } : {}),
              ...(record.currentTurnId ? { activeTurnId: record.currentTurnId } : {}),
              ...(record.lastError ? { lastError: record.lastError } : {}),
            }) satisfies ProviderSession,
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
