/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import type {
  ProviderEvent,
  ProviderRuntimeEvent,
  ProviderRuntimeTurnStatus,
  ProviderRuntimeToolKind,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "codex" as const;

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: () => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  sessionId: string,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(sessionId: string, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(sessionId, cause);
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

function toTurnStatus(value: unknown): ProviderRuntimeTurnStatus | undefined {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return undefined;
  }
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shouldDropItemType(type: string): boolean {
  if (type.includes("preamble") || type.includes("reasoning") || type.includes("thought")) {
    return true;
  }
  return type === "work" || type.startsWith("work ");
}

function toolMeta(type: string):
  | {
      readonly toolKind: ProviderRuntimeToolKind;
      readonly title: string;
    }
  | undefined {
  if (type.includes("command")) {
    return { toolKind: "command", title: "Command run" };
  }
  if (type.includes("file change")) {
    return { toolKind: "file-change", title: "File change" };
  }
  if (type.includes("tool")) {
    return { toolKind: "other", title: "Tool call" };
  }
  return undefined;
}

function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    asString(item.text),
    asString(item.path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function mapMessageCompletedEvent(event: ProviderEvent): ProviderRuntimeEvent | undefined {
  if (event.method !== "item/completed") {
    return undefined;
  }

  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  if (!item) {
    return undefined;
  }

  const normalizedType = normalizeItemType(item.type ?? item.kind);
  if (!normalizedType.includes("agent message")) {
    return undefined;
  }

  const itemId = event.itemId ?? asString(item.id);
  if (!itemId) {
    return undefined;
  }

  return {
    type: "message.completed",
    eventId: event.id,
    provider: event.provider,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    itemId,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
  };
}

function mapToolEvent(event: ProviderEvent): ProviderRuntimeEvent | undefined {
  if (event.method !== "item/started" && event.method !== "item/completed") {
    return undefined;
  }
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  if (!item) {
    return undefined;
  }
  const normalizedType = normalizeItemType(item.type ?? item.kind);
  if (shouldDropItemType(normalizedType)) {
    return undefined;
  }
  const meta = toolMeta(normalizedType);
  if (!meta) {
    return undefined;
  }

  const eventBase = {
    eventId: event.id,
    provider: event.provider,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: event.itemId } : {}),
    toolKind: meta.toolKind,
    title: meta.title,
    ...(payload ? { detail: itemDetail(item, payload) } : {}),
  } as const;

  if (event.method === "item/started") {
    return {
      type: "tool.started",
      ...eventBase,
    };
  }

  return {
    type: "tool.completed",
    ...eventBase,
  };
}

function mapToRuntimeEvents(event: ProviderEvent): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        type: "runtime.error",
        eventId: event.id,
        provider: event.provider,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.itemId ? { itemId: event.itemId } : {}),
        message: event.message,
      },
    ];
  }

  if (event.kind === "request" && event.requestId && event.requestKind) {
    const detail =
      asString(payload?.command) ?? asString(payload?.reason) ?? asString(payload?.prompt);
    return [
      {
        type: "approval.requested",
        eventId: event.id,
        provider: event.provider,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.itemId ? { itemId: event.itemId } : {}),
        requestId: event.requestId,
        requestKind: event.requestKind,
        ...(detail ? { detail } : {}),
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decision = asString(payload?.decision);
    return [
      {
        type: "approval.resolved",
        eventId: event.id,
        provider: event.provider,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.itemId ? { itemId: event.itemId } : {}),
        requestId: event.requestId,
        ...(event.requestKind ? { requestKind: event.requestKind } : {}),
        ...(decision ? { decision } : {}),
      },
    ];
  }

  const messageCompleted = mapMessageCompletedEvent(event);
  if (messageCompleted) {
    return [messageCompleted];
  }

  const tool = mapToolEvent(event);
  if (tool) {
    return [tool];
  }

  if (event.method === "session/started") {
    return [
      {
        type: "session.started",
        eventId: event.id,
        provider: event.provider,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.message ? { message: event.message } : {}),
      },
    ];
  }

  if (event.method === "session/exited") {
    return [
      {
        type: "session.exited",
        eventId: event.id,
        provider: event.provider,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.message ? { message: event.message } : {}),
      },
    ];
  }

  if (event.method === "thread/started") {
    const threadId = event.threadId ?? asString(asObject(payload?.thread)?.id);
    if (!threadId) {
      return [];
    }
    return [
      {
        type: "thread.started",
        eventId: event.id,
        provider: event.provider,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        threadId,
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId ?? asString(turn?.id);
    if (!turnId) {
      return [];
    }
    return [
      {
        type: "turn.started",
        eventId: event.id,
        provider: event.provider,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        ...(event.threadId ? { threadId: event.threadId } : {}),
        turnId,
      },
    ];
  }

  if (event.method === "turn/completed") {
    return [
      {
        type: "turn.completed",
        eventId: event.id,
        provider: event.provider,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(toTurnStatus(turn?.status) ? { status: toTurnStatus(turn?.status) } : {}),
        ...(asString(asObject(turn?.error)?.message)
          ? { errorMessage: asString(asObject(turn?.error)?.message) }
          : {}),
      },
    ];
  }

  if (event.method === "item/agentMessage/delta" && event.textDelta && event.textDelta.length > 0) {
    return [
      {
        type: "message.delta",
        eventId: event.id,
        provider: event.provider,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.itemId ? { itemId: event.itemId } : {}),
        delta: event.textDelta,
      },
    ];
  }

  return [];
}

const makeCodexAdapter = (options?: CodexAdapterLiveOptions) =>
  Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogPath !== undefined
        ? makeEventNdjsonLogger(options.nativeEventLogPath)
        : undefined;

    const manager = yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (options?.manager) {
          return options.manager;
        }
        if (options?.makeManager) {
          return options.makeManager();
        }
        return new CodexAppServerManager();
      }),
      (manager) =>
        Effect.sync(() => {
          try {
            manager.stopAll();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );

    const startSession: CodexAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.startSession(input),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            sessionId: "pending",
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            cause,
          }),
      });
    };

    const sendTurn: CodexAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: () => manager.sendTurn(input),
        catch: (cause) => toRequestError(input.sessionId, "turn/start", cause),
      });

    const interruptTurn: CodexAdapterShape["interruptTurn"] = (sessionId, turnId) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(sessionId, turnId),
        catch: (cause) => toRequestError(sessionId, "turn/interrupt", cause),
      });

    const readThread: CodexAdapterShape["readThread"] = (sessionId) =>
      Effect.tryPromise({
        try: () => manager.readThread(sessionId),
        catch: (cause) => toRequestError(sessionId, "thread/read", cause),
      });

    const rollbackThread: CodexAdapterShape["rollbackThread"] = (sessionId, numTurns) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.rollbackThread(sessionId, numTurns),
        catch: (cause) => toRequestError(sessionId, "thread/rollback", cause),
      });
    };

    const respondToRequest: CodexAdapterShape["respondToRequest"] = (
      sessionId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(sessionId, requestId, decision),
        catch: (cause) => toRequestError(sessionId, "item/requestApproval/decision", cause),
      });

    const stopSession: CodexAdapterShape["stopSession"] = (sessionId) =>
      Effect.sync(() => {
        manager.stopSession(sessionId);
      });

    const listSessions: CodexAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: CodexAdapterShape["hasSession"] = (sessionId) =>
      Effect.sync(() => manager.hasSession(sessionId));

    const stopAll: CodexAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        manager.stopAll();
      });

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (event: ProviderEvent) => {
          nativeEventLogger?.write({
            observedAt: new Date().toISOString(),
            event,
          });
          Queue.offerAllUnsafe(runtimeEventQueue, mapToRuntimeEvents(event));
        };
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
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CodexAdapterShape;
  });

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
