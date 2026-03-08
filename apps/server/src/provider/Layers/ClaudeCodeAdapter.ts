import {
  type CanonicalItemType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type RuntimeErrorClass,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, ServiceMap, Stream } from "effect";

import {
  ClaudeCodeServerManager,
  type ClaudeCodeServerSendTurnInput,
  type ClaudeCodeServerStartSessionInput,
} from "../../claudeCodeServerManager.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";

const PROVIDER = "claudeCode" as const;

export interface ClaudeCodeAdapterLiveOptions {
  readonly manager?: ClaudeCodeServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => ClaudeCodeServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown provider session") || normalized.includes("unknown session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed") || normalized.includes("session is busy")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toRuntimeErrorClass(value: unknown): RuntimeErrorClass | undefined {
  const errorClass = asString(value);
  switch (errorClass) {
    case "provider_error":
    case "transport_error":
    case "permission_error":
    case "validation_error":
    case "unknown":
      return errorClass;
    default:
      return undefined;
  }
}

function toCanonicalItemType(toolName: string | undefined): CanonicalItemType {
  switch (toolName) {
    case "Bash":
      return "command_execution";
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return "file_change";
    case "Task":
    case "TaskOutput":
      return "collab_agent_tool_call";
    case "WebSearch":
    case "web_search":
    case "WebFetch":
    case "web_fetch":
      return "web_search";
    default:
      return toolName?.startsWith("mcp__") ? "mcp_tool_call" : "dynamic_tool_call";
  }
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: RuntimeItemId.makeUnsafe(event.itemId) } : {}),
    raw: {
      source: "claude-code.stream-json",
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  if (!item || !event.itemId) {
    return undefined;
  }
  const toolName = asString(item.toolName);
  const detail = asString(item.summary) ?? asString(item.toolName);
  const status =
    lifecycle === "item.completed"
      ? asString(item.status) === "failed"
        ? "failed"
        : "completed"
      : "inProgress";

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType: toCanonicalItemType(toolName),
      status,
      ...(toolName ? { title: toolName } : {}),
      ...(detail ? { detail } : {}),
      data: event.payload ?? {},
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);

  if (event.kind === "error") {
    return event.message
      ? [
          {
            ...runtimeEventBase(event, canonicalThreadId),
            type: "runtime.error",
            payload: {
              message: event.message,
              class: toRuntimeErrorClass(payload?.class) ?? "provider_error",
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
        ]
      : [];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(payload?.resume !== undefined ? { resume: payload.resume } : {}),
        },
      },
    ];
  }

  if (event.method === "session/configured") {
    const config = asObject(payload?.config);
    if (!config) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.configured",
        payload: {
          config,
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const providerThreadId = asString(payload?.providerThreadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const errorMessage = asString(asObject(turn?.error)?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state:
            asString(turn?.status) === "failed" ||
            asString(turn?.status) === "interrupted" ||
            asString(turn?.status) === "cancelled"
              ? (asString(turn?.status) as "failed" | "interrupted" | "cancelled")
              : "completed",
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined ? { totalCostUsd: asNumber(turn?.totalCostUsd) } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/content-delta") {
    const streamKind = asString(payload?.streamKind);
    const delta = asString(payload?.delta);
    if (!streamKind || delta === undefined) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            streamKind === "reasoning_text" ? "reasoning_text" : "assistant_text",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/tool/started") {
    const mapped = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return mapped ? [mapped] : [];
  }

  if (event.method === "item/tool/updated") {
    const mapped = mapItemLifecycle(event, canonicalThreadId, "item.updated");
    return mapped ? [mapped] : [];
  }

  if (event.method === "item/tool/completed") {
    const mapped = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return mapped ? [mapped] : [];
  }

  if (event.method === "task/started") {
    const taskId = asString(payload?.taskId);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(taskId),
          ...(asString(payload?.description) ? { description: asString(payload?.description) } : {}),
          ...(asString(payload?.taskType) ? { taskType: asString(payload?.taskType) } : {}),
        },
      },
    ];
  }

  if (event.method === "task/progress") {
    const taskId = asString(payload?.taskId);
    const description = asString(payload?.description);
    if (!taskId || !description) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(taskId),
          description,
          ...(payload?.usage !== undefined ? { usage: payload.usage } : {}),
        },
      },
    ];
  }

  if (event.method === "task/completed") {
    const taskId = asString(payload?.taskId);
    const status = asString(payload?.status);
    if (!taskId || (status !== "completed" && status !== "failed" && status !== "stopped")) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(taskId),
          status,
          ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
          ...(payload?.usage !== undefined ? { usage: payload.usage } : {}),
        },
      },
    ];
  }

  if (event.method === "hook/started") {
    const hookId = asString(payload?.hookId);
    const hookName = asString(payload?.hookName);
    const hookEvent = asString(payload?.hookEvent);
    if (!hookId || !hookName || !hookEvent) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "hook.started",
        payload: {
          hookId,
          hookName,
          hookEvent,
        },
      },
    ];
  }

  if (event.method === "hook/completed") {
    const hookId = asString(payload?.hookId);
    const outcome = asString(payload?.outcome);
    if (!hookId || (outcome !== "success" && outcome !== "error" && outcome !== "cancelled")) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "hook.completed",
        payload: {
          hookId,
          outcome,
          ...(asString(payload?.output) !== undefined ? { output: asString(payload?.output) } : {}),
          ...(asString(payload?.stdout) !== undefined ? { stdout: asString(payload?.stdout) } : {}),
          ...(asString(payload?.stderr) !== undefined ? { stderr: asString(payload?.stderr) } : {}),
          ...(asNumber(payload?.exitCode) !== undefined ? { exitCode: asNumber(payload?.exitCode) } : {}),
        },
      },
    ];
  }

  return [];
}

const makeClaudeCodeAdapter = (options?: ClaudeCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);

    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) {
          return options.manager;
        }
        const services = yield* Effect.services<never>();
        return options?.makeManager?.(services) ?? new ClaudeCodeServerManager();
      }),
      (manager) =>
        Effect.sync(() => {
          try {
            manager.stopAll();
          } catch {
            return undefined;
          }
        }),
    );

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.startSession({
            provider: "claudeCode",
            threadId: input.threadId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
            ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
            runtimeMode: input.runtimeMode,
          } satisfies ClaudeCodeServerStartSessionInput),
        catch: (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: toMessage(cause, "Claude Code session start failed"),
            cause,
          }),
      });

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.sendTurn({
            threadId: input.threadId,
            ...(input.input !== undefined ? { input: input.input } : {}),
            ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
          } satisfies ClaudeCodeServerSendTurnInput),
        catch: (cause) => toRequestError(input.threadId, "sendTurn", cause),
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(threadId, turnId),
        catch: (cause) => toRequestError(threadId, "interruptTurn", cause),
      });

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(threadId, requestId, decision),
        catch: (cause) => toRequestError(threadId, "respondToRequest", cause),
      });

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToUserInput(threadId, requestId, answers),
        catch: (cause) => toRequestError(threadId, "respondToUserInput", cause),
      });

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.try({
        try: () => manager.stopSession(threadId),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "stopSession failed"),
            cause,
          }),
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.readThread(threadId),
        catch: (cause) => toRequestError(threadId, "readThread", cause),
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.tryPromise({
        try: () => manager.rollbackThread(threadId, numTurns),
        catch: (cause) => toRequestError(threadId, "rollbackThread", cause),
      });

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        manager.stopAll();
      });

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const writeNativeEvent = (event: ProviderEvent) =>
          Effect.gen(function* () {
            if (!nativeEventLogger) {
              return;
            }
            yield* nativeEventLogger.write(event, event.threadId);
          });

        const services = yield* Effect.services<never>();
        const listener = (event: ProviderEvent) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event);
            const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
            if (runtimeEvents.length === 0) {
              return;
            }
            yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
          }).pipe(Effect.runPromiseWith(services));

        manager.on("event", listener);
        return listener;
      }),
      (listener) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            manager.off("event", listener);
          });
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

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
      readThread,
      rollbackThread,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeCodeAdapterShape;
  });

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}