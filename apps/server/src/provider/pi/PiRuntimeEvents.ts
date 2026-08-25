// @effect-diagnostics globalDate:off
import {
  EventId,
  IsoDateTime,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import type { PiRpcOutput } from "./PiRpcProtocol.ts";

const PI_DRIVER = ProviderDriverKind.make("piAgent");

interface PiRuntimeEventMapperOptions {
  readonly provider?: ProviderDriverKind;
  readonly providerName?: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly now?: () => string;
  readonly nextId?: (prefix: string) => string;
}

interface PiContentState {
  readonly itemId: RuntimeItemId;
  readonly streamKind: "assistant_text" | "reasoning_text";
  readonly itemType: "assistant_message" | "reasoning";
  emittedText: string;
}

interface PiToolState {
  readonly itemId: RuntimeItemId;
  readonly toolName: string;
  readonly itemType:
    | "command_execution"
    | "file_change"
    | "dynamic_tool_call"
    | "web_search"
    | "image_view";
  readonly args: unknown;
}

interface PiSessionStats {
  readonly tokens?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
  readonly toolCalls?: number;
  readonly contextUsage?: {
    readonly contextWindow?: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

type PiAssistantOutcome =
  | { readonly state: "failed"; readonly errorMessage: string }
  | { readonly state: "interrupted" };

function assistantMessageOutcome(
  value: unknown,
  providerName: string,
): PiAssistantOutcome | undefined {
  const message = asRecord(value);
  if (message?.role !== "assistant") return undefined;
  if (message.stopReason === "aborted") return { state: "interrupted" };
  if (message.stopReason === "error") {
    return {
      state: "failed",
      errorMessage: nonEmptyString(message.errorMessage) ?? `${providerName} request failed`,
    };
  }
  return undefined;
}

function agentEndOutcome(
  record: Record<string, unknown>,
  providerName: string,
): PiAssistantOutcome | undefined {
  if (!Array.isArray(record.messages)) return undefined;
  for (let index = record.messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(record.messages[index]);
    if (message?.role === "assistant") return assistantMessageOutcome(message, providerName);
  }
  return undefined;
}

export function isPiTurnSettledEvent(raw: PiRpcOutput): boolean {
  if (raw.type === "agent_settled") return true;
  const record = raw as Record<string, unknown>;
  if (raw.type === "prompt_result") return record.agentInvoked === false;
  if (raw.type !== "agent_end") return false;
  if (typeof record.isTerminal === "boolean") return record.isTerminal;
  // Pi versions with agent_settled add willRetry to agent_end. Older Pi
  // versions omit both completion hints and treat agent_end as terminal.
  return typeof record.willRetry !== "boolean";
}

function piAgentEndWillContinue(record: Record<string, unknown>): boolean {
  if (typeof record.isTerminal === "boolean") return !record.isTerminal;
  return record.willRetry === true;
}

function isCroppedAgentEnd(record: Record<string, unknown>): boolean {
  return (
    Array.isArray(record.messages) &&
    record.messages.length === 0 &&
    Number.isSafeInteger(record.messageCount) &&
    typeof record.isTerminal !== "boolean" &&
    typeof record.willRetry !== "boolean"
  );
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => extractText(entry))
      .filter((entry): entry is string => entry !== undefined)
      .join("\n")
      .trim();
    return text || undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  return (
    nonEmptyString(record.text) ??
    extractText(record.content) ??
    extractText(record.output) ??
    extractText(record.message)
  );
}

function contentSnapshot(
  value: unknown,
):
  | { readonly streamKind: "assistant_text"; readonly text: string }
  | { readonly streamKind: "reasoning_text"; readonly text: string }
  | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
    return { streamKind: "assistant_text", text: record.text };
  }
  if (record.type === "thinking" && typeof record.thinking === "string" && record.thinking.trim()) {
    return { streamKind: "reasoning_text", text: record.thinking };
  }
  return undefined;
}

function missingSnapshotSuffix(emittedText: string, snapshot: string): string | undefined {
  if (!snapshot.startsWith(emittedText) || snapshot.length === emittedText.length) return undefined;
  return snapshot.slice(emittedText.length);
}

function classifyTool(toolName: string): PiToolState["itemType"] {
  switch (toolName.toLowerCase()) {
    case "bash":
    case "shell":
    case "command":
      return "command_execution";
    case "write":
    case "edit":
    case "apply_patch":
      return "file_change";
    case "web_search":
    case "websearch":
      return "web_search";
    case "view_image":
    case "image":
      return "image_view";
    default:
      return "dynamic_tool_call";
  }
}

function inputQuestion(request: Record<string, unknown>, providerName: string) {
  const method = request.method;
  const title = nonEmptyString(request.title) ?? providerName;
  if (method === "confirm") {
    return {
      id: "value",
      header: title,
      question: nonEmptyString(request.message) ?? title,
      options: [
        { label: "Yes", description: "Confirm this action" },
        { label: "No", description: "Decline this action" },
      ],
    } as const;
  }
  if (method === "select") {
    const options = Array.isArray(request.options)
      ? request.options
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((label) => ({ label, description: label }))
      : [];
    return {
      id: "value",
      header: title,
      question: title,
      options,
    } as const;
  }
  return {
    id: "value",
    header: title,
    question: nonEmptyString(request.placeholder) ?? title,
    options: [],
  } as const;
}

export function makePiRuntimeEventMapper(options: PiRuntimeEventMapperOptions) {
  const provider = options.provider ?? PI_DRIVER;
  const providerName = options.providerName ?? "Pi";
  let sequence = 0;
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? ((prefix: string) => `${prefix}-${++sequence}`);
  let activeTurnId: TurnId | undefined;
  let turnFailed = false;
  let turnInterrupted = false;
  let turnErrorMessage: string | undefined;
  let attemptErrorMessage: string | undefined;
  let attemptInterrupted = false;
  let pendingFrameErrorMessage: string | undefined;
  const contentItems = new Map<string, PiContentState>();
  const tools = new Map<string, PiToolState>();

  const event = (
    type: ProviderRuntimeEvent["type"],
    payload: unknown,
    extra: {
      readonly itemId?: RuntimeItemId;
      readonly requestId?: RuntimeRequestId;
      readonly raw?: PiRpcOutput;
      readonly turnId?: TurnId;
    } = {},
  ): ProviderRuntimeEvent =>
    ({
      type,
      eventId: EventId.make(nextId("pi-event")),
      provider,
      providerInstanceId: options.providerInstanceId,
      threadId: options.threadId,
      createdAt: IsoDateTime.make(now()),
      ...((extra.turnId ?? activeTurnId) ? { turnId: extra.turnId ?? activeTurnId } : {}),
      ...(extra.itemId ? { itemId: extra.itemId } : {}),
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
      ...(extra.raw
        ? {
            raw: {
              source: "pi.rpc.event",
              messageType: extra.raw.type,
              payload: extra.raw,
            },
          }
        : {}),
      payload,
    }) as ProviderRuntimeEvent;

  const startSession = (input: { readonly sessionId: string; readonly sessionFile?: string }) => {
    const resume = {
      sessionId: input.sessionId,
      ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
    };
    return [
      event("session.started", { message: `${providerName} RPC session started`, resume }),
      event("session.configured", { config: resume }),
      event("session.state.changed", { state: "ready" }),
      event("thread.started", { providerThreadId: input.sessionId }),
      event("thread.state.changed", { state: "idle" }),
    ];
  };

  const startTurn = (input: {
    readonly turnId: TurnId;
    readonly model?: string;
    readonly effort?: string;
  }) => {
    activeTurnId = input.turnId;
    turnFailed = false;
    turnInterrupted = false;
    turnErrorMessage = undefined;
    attemptErrorMessage = undefined;
    attemptInterrupted = false;
    pendingFrameErrorMessage = undefined;
    contentItems.clear();
    tools.clear();
    return [
      event("turn.started", {
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
      }),
      event("session.state.changed", { state: "running" }),
      event("thread.state.changed", { state: "active" }),
    ];
  };

  const contentItem = (streamKind: "assistant_text" | "reasoning_text", contentIndex: number) => {
    const key = `${streamKind}:${contentIndex}`;
    const existing = contentItems.get(key);
    if (existing) return { state: existing, started: false };
    const state: PiContentState = {
      itemId: RuntimeItemId.make(nextId(`pi-${streamKind}`)),
      streamKind,
      itemType: streamKind === "reasoning_text" ? "reasoning" : "assistant_message",
      emittedText: "",
    };
    contentItems.set(key, state);
    return { state, started: true };
  };

  const completeOpenContent = (raw?: PiRpcOutput) => {
    const completed = [...contentItems.values()].map((state) =>
      event(
        "item.completed",
        {
          itemType: state.itemType,
          status: "completed",
        },
        { itemId: state.itemId, ...(raw ? { raw } : {}) },
      ),
    );
    contentItems.clear();
    return completed;
  };

  const completeOpenTools = (
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
    raw?: PiRpcOutput,
  ) => {
    const completed = [...tools.entries()].map(([toolCallId, tool]) =>
      event(
        "item.completed",
        {
          itemType: tool.itemType,
          status: state === "completed" ? "completed" : "failed",
          title: tool.toolName,
          ...(state === "interrupted" || state === "cancelled"
            ? { detail: "Interrupted" }
            : errorMessage
              ? { detail: errorMessage }
              : {}),
          data: { toolCallId, toolName: tool.toolName, args: tool.args },
        },
        { itemId: tool.itemId, ...(raw ? { raw } : {}) },
      ),
    );
    tools.clear();
    return completed;
  };

  const completeTurn = (
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
    raw?: PiRpcOutput,
  ) => {
    if (!activeTurnId) return [];
    const completedContent = completeOpenContent(raw);
    const completedTools = completeOpenTools(state, errorMessage, raw);
    const turnId = activeTurnId;
    activeTurnId = undefined;
    attemptErrorMessage = undefined;
    attemptInterrupted = false;
    pendingFrameErrorMessage = undefined;
    const sessionCompletion =
      state === "failed"
        ? [
            event(
              "session.state.changed",
              { state: "error", ...(errorMessage ? { reason: errorMessage } : {}) },
              { turnId },
            ),
          ]
        : state === "completed"
          ? [event("session.state.changed", { state: "ready" }, { turnId })]
          : [];
    return [
      ...completedContent,
      ...completedTools,
      event(
        "turn.completed",
        {
          state,
          ...(errorMessage ? { errorMessage } : {}),
        },
        { turnId, ...(raw ? { raw } : {}) },
      ),
      ...sessionCompletion,
      event("thread.state.changed", { state: "idle" }, { turnId }),
    ];
  };

  const mapMessageUpdate = (raw: PiRpcOutput, record: Record<string, unknown>) => {
    if (!activeTurnId) return [];
    const delta = asRecord(record.assistantMessageEvent);
    if (!delta || typeof delta.type !== "string") return [];
    if (delta.type === "error") {
      const assistantError = asRecord(delta.error);
      attemptErrorMessage =
        nonEmptyString(assistantError?.errorMessage) ??
        nonEmptyString(delta.error) ??
        nonEmptyString(delta.reason) ??
        `${providerName} request failed`;
      return [];
    }
    const isText = delta.type.startsWith("text_");
    const isThinking = delta.type.startsWith("thinking_");
    if (!isText && !isThinking) return [];
    const streamKind = isThinking ? "reasoning_text" : "assistant_text";
    const contentIndex = nonNegativeInt(delta.contentIndex) ?? 0;
    const item = contentItem(streamKind, contentIndex);
    const state = item.state;
    const events: ProviderRuntimeEvent[] = [];
    if (item.started) {
      events.push(
        event(
          "item.started",
          {
            itemType: isThinking ? "reasoning" : "assistant_message",
            status: "inProgress",
          },
          { itemId: state.itemId, raw },
        ),
      );
    }
    if (delta.type.endsWith("_delta") && typeof delta.delta === "string") {
      state.emittedText += delta.delta;
      events.push(
        event(
          "content.delta",
          { streamKind, delta: delta.delta, contentIndex },
          { itemId: state.itemId, raw },
        ),
      );
    }
    if (delta.type.endsWith("_end")) {
      if (typeof delta.content === "string") {
        const suffix = missingSnapshotSuffix(state.emittedText, delta.content);
        if (suffix !== undefined) {
          state.emittedText += suffix;
          events.push(
            event(
              "content.delta",
              { streamKind, delta: suffix, contentIndex },
              { itemId: state.itemId, raw },
            ),
          );
        }
      }
    }
    return events;
  };

  const mapMessageEnd = (raw: PiRpcOutput, record: Record<string, unknown>) => {
    if (!activeTurnId) return [];
    const message = asRecord(record.message);
    if (message?.role !== "assistant") return [];
    pendingFrameErrorMessage = undefined;
    const outcome = assistantMessageOutcome(message, providerName);
    if (outcome?.state === "interrupted") {
      attemptInterrupted = true;
    } else if (outcome?.state === "failed") {
      attemptErrorMessage = outcome.errorMessage;
    }
    if (!Array.isArray(message.content)) return [];
    const events: ProviderRuntimeEvent[] = [];
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
      const snapshot = contentSnapshot(message.content[contentIndex]);
      if (!snapshot) continue;
      const item = contentItem(snapshot.streamKind, contentIndex);
      const state = item.state;
      if (item.started) {
        events.push(
          event(
            "item.started",
            { itemType: state.itemType, status: "inProgress" },
            { itemId: state.itemId, raw },
          ),
        );
      }
      const suffix = missingSnapshotSuffix(state.emittedText, snapshot.text);
      if (suffix !== undefined) {
        state.emittedText += suffix;
        events.push(
          event(
            "content.delta",
            { streamKind: state.streamKind, delta: suffix, contentIndex },
            { itemId: state.itemId, raw },
          ),
        );
      }
    }
    return [...events, ...completeOpenContent(raw)];
  };

  const mapTool = (raw: PiRpcOutput, record: Record<string, unknown>) => {
    if (!activeTurnId) return [];
    const toolCallId = nonEmptyString(record.toolCallId);
    const toolName = nonEmptyString(record.toolName);
    if (!toolCallId || !toolName) return [];
    if (raw.type === "tool_execution_start") {
      const tool: PiToolState = {
        itemId: RuntimeItemId.make(nextId("pi-tool")),
        toolName,
        itemType: classifyTool(toolName),
        args: record.args,
      };
      tools.set(toolCallId, tool);
      return [
        event(
          "item.started",
          {
            itemType: tool.itemType,
            status: "inProgress",
            title: toolName,
            detail: extractText(record.args),
            data: { toolCallId, toolName, args: record.args },
          },
          { itemId: tool.itemId, raw },
        ),
      ];
    }
    const tool = tools.get(toolCallId);
    if (!tool) return [];
    const result = raw.type === "tool_execution_update" ? record.partialResult : record.result;
    const detail = extractText(result);
    const data = {
      toolCallId,
      toolName,
      args: tool.args,
      rawOutput: result,
    };
    if (raw.type === "tool_execution_update") {
      return [
        event(
          "item.updated",
          {
            itemType: tool.itemType,
            status: "inProgress",
            title: toolName,
            ...(detail ? { detail } : {}),
            data,
          },
          { itemId: tool.itemId, raw },
        ),
      ];
    }
    tools.delete(toolCallId);
    return [
      event(
        "item.completed",
        {
          itemType: tool.itemType,
          status: record.isError === true ? "failed" : "completed",
          title: toolName,
          ...(detail ? { detail } : {}),
          data,
        },
        { itemId: tool.itemId, raw },
      ),
    ];
  };

  const map = (raw: PiRpcOutput): ReadonlyArray<ProviderRuntimeEvent> => {
    const record = raw as Record<string, unknown>;
    switch (raw.type) {
      case "message_update":
        return mapMessageUpdate(raw, record);
      case "message_end":
        return mapMessageEnd(raw, record);
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        return mapTool(raw, record);
      case "agent_end": {
        if (!activeTurnId) return [];
        const events = [...completeOpenContent(raw)];
        const croppedAgentEndError = isCroppedAgentEnd(record)
          ? (pendingFrameErrorMessage ?? `${providerName} agent_end exceeded the RPC frame limit`)
          : undefined;
        const pendingErrorMessage =
          croppedAgentEndError ?? attemptErrorMessage ?? pendingFrameErrorMessage;
        const outcome =
          croppedAgentEndError !== undefined
            ? { state: "failed" as const, errorMessage: croppedAgentEndError }
            : (agentEndOutcome(record, providerName) ??
              (attemptInterrupted
                ? { state: "interrupted" as const }
                : pendingErrorMessage
                  ? { state: "failed" as const, errorMessage: pendingErrorMessage }
                  : undefined));
        const errorMessage = outcome?.state === "failed" ? outcome.errorMessage : undefined;
        attemptErrorMessage = undefined;
        attemptInterrupted = false;
        pendingFrameErrorMessage = undefined;
        const willContinue = piAgentEndWillContinue(record);
        if (!willContinue) {
          if (outcome?.state === "interrupted") {
            turnInterrupted = true;
          } else if (errorMessage) {
            turnFailed = true;
            turnErrorMessage = errorMessage;
            events.push(
              event(
                "runtime.error",
                { message: errorMessage, class: "provider_error", detail: raw },
                { raw },
              ),
            );
          }
        }
        if (isPiTurnSettledEvent(raw)) {
          events.push(
            ...completeTurn(
              turnFailed ? "failed" : turnInterrupted ? "interrupted" : "completed",
              turnErrorMessage,
              raw,
            ),
          );
        }
        return events;
      }
      case "rpc_frame_error": {
        if (!activeTurnId || record.originalType !== "message_end") return [];
        pendingFrameErrorMessage =
          nonEmptyString(record.error) ?? `${providerName} response exceeded the RPC frame limit`;
        return [];
      }
      case "prompt_result":
        return isPiTurnSettledEvent(raw)
          ? [
              ...completeOpenContent(raw),
              ...completeTurn(
                turnFailed ? "failed" : turnInterrupted ? "interrupted" : "completed",
                turnErrorMessage,
                raw,
              ),
            ]
          : [];
      case "agent_settled": {
        const events = [...completeOpenContent(raw)];
        const unsettledErrorMessage = attemptErrorMessage ?? pendingFrameErrorMessage;
        if (unsettledErrorMessage) {
          turnFailed = true;
          turnErrorMessage = unsettledErrorMessage;
          events.push(
            event(
              "runtime.error",
              { message: unsettledErrorMessage, class: "provider_error" },
              { raw },
            ),
          );
          attemptErrorMessage = undefined;
          pendingFrameErrorMessage = undefined;
        }
        if (attemptInterrupted) {
          turnInterrupted = true;
          attemptInterrupted = false;
        }
        return [
          ...events,
          ...completeTurn(
            turnFailed ? "failed" : turnInterrupted ? "interrupted" : "completed",
            turnErrorMessage,
            raw,
          ),
        ];
      }
      case "extension_error": {
        turnFailed = true;
        const message = nonEmptyString(record.error) ?? `${providerName} extension failed`;
        turnErrorMessage = message;
        return [event("runtime.error", { message, class: "provider_error", detail: raw }, { raw })];
      }
      case "extension_ui_request": {
        if (
          record.method === "confirm" ||
          record.method === "select" ||
          record.method === "input" ||
          record.method === "editor"
        ) {
          return [
            event(
              "user-input.requested",
              { questions: [inputQuestion(record, providerName)] },
              { requestId: RuntimeRequestId.make(String(record.id)), raw },
            ),
          ];
        }
        if (record.method === "notify") {
          const message = nonEmptyString(record.message) ?? `${providerName} notification`;
          return [
            event(
              record.notifyType === "error" ? "runtime.error" : "runtime.warning",
              record.notifyType === "error"
                ? { message, class: "provider_error" }
                : { message, detail: raw },
              { raw },
            ),
          ];
        }
        return [];
      }
      default:
        return [];
    }
  };

  const updateTokenUsage = (stats: PiSessionStats) => {
    const tokens = stats.tokens;
    if (!tokens) return [];
    const usedTokens =
      nonNegativeInt(tokens.total) ??
      (nonNegativeInt(tokens.input) ?? 0) +
        (nonNegativeInt(tokens.output) ?? 0) +
        (nonNegativeInt(tokens.cacheRead) ?? 0);
    return [
      event("thread.token-usage.updated", {
        usage: {
          usedTokens,
          totalProcessedTokens: usedTokens,
          ...(nonNegativeInt(tokens.input) !== undefined ? { inputTokens: tokens.input } : {}),
          ...(nonNegativeInt(tokens.cacheRead) !== undefined
            ? { cachedInputTokens: tokens.cacheRead }
            : {}),
          ...(nonNegativeInt(tokens.output) !== undefined ? { outputTokens: tokens.output } : {}),
          ...(nonNegativeInt(stats.toolCalls) !== undefined ? { toolUses: stats.toolCalls } : {}),
          ...(nonNegativeInt(stats.contextUsage?.contextWindow) !== undefined
            ? { maxTokens: stats.contextUsage?.contextWindow }
            : {}),
          compactsAutomatically: true,
        },
      }),
    ];
  };

  const failRuntime = (message: string) => [
    event("runtime.error", { message, class: "provider_error" }),
    ...completeTurn("failed", message),
  ];

  const resolveUserInput = (requestId: string, answer: unknown) => [
    event(
      "user-input.resolved",
      { answers: { value: answer } },
      { requestId: RuntimeRequestId.make(requestId) },
    ),
  ];

  return {
    startSession,
    startTurn,
    map,
    completeTurn,
    failRuntime,
    updateTokenUsage,
    resolveUserInput,
  };
}

export type PiRuntimeEventMapper = ReturnType<typeof makePiRuntimeEventMapper>;
