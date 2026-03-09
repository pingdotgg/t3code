import { randomUUID } from "node:crypto";

import {
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getDefaultModel, normalizeModelSlug } from "@t3tools/shared/model";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { OpencodeAdapter, type OpencodeAdapterShape } from "../Services/OpencodeAdapter.ts";
import { OpencodeCliManager } from "../../opencodeCliManager.ts";

const PROVIDER = "opencode" as const;

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(`opencode_${randomUUID()}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapOpencodeEventToCanonical(rawEvent: Record<string, unknown>): ProviderRuntimeEvent | null {
  const method = rawEvent.method;
  const threadId = rawEvent.threadId;
  const turnId = rawEvent.turnId;

  if (typeof method !== "string" || typeof threadId !== "string") {
    return null;
  }

  const base: Omit<ProviderRuntimeEvent, "type" | "payload"> = {
    eventId: makeEventId(),
    provider: PROVIDER,
    threadId: ThreadId.makeUnsafe(threadId),
    createdAt: nowIso(),
    ...(typeof turnId === "string" && turnId.length > 0
      ? { turnId: TurnId.makeUnsafe(turnId) }
      : {}),
  };

  switch (method) {
    case "session/started":
      return {
        ...base,
        type: "session.started",
        payload: {},
      };

    case "session/configured":
      return {
        ...base,
        type: "session.configured",
        payload: {
          config: {
            resumeCursor: rawEvent.resumeCursor,
          },
        },
      };

    case "session/ready":
      return {
        ...base,
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(typeof rawEvent.message === "string" ? { reason: rawEvent.message } : {}),
        },
      };

    case "turn/started":
      return {
        ...base,
        type: "turn.started",
        payload: typeof rawEvent.model === "string" ? { model: rawEvent.model } : {},
      };

    case "turn/ended":
      return {
        ...base,
        type: "turn.completed",
        payload: {
          state: rawEvent.exitCode === 0 ? "completed" : "failed",
        },
      };

    case "turn/error":
      return {
        ...base,
        type: "runtime.error",
        payload: {
          message: typeof rawEvent.message === "string" ? rawEvent.message : "Opencode error",
          class: "provider_error",
        },
      };

    case "opencode/message":
      return {
        ...base,
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: typeof rawEvent.content === "string" ? rawEvent.content : "",
        },
      };

    case "opencode/tool_use":
      return {
        ...base,
        type: "item.started",
        payload: {
          itemType: "dynamic_tool_call",
          status: "inProgress",
          title: typeof rawEvent.tool_name === "string" ? rawEvent.tool_name : "Tool",
          detail: rawEvent.parameters ? JSON.stringify(rawEvent.parameters) : undefined,
          data: rawEvent,
        },
        itemId: typeof rawEvent.tool_id === "string" ? RuntimeItemId.makeUnsafe(rawEvent.tool_id) : undefined,
      };

    case "opencode/tool_update":
      return {
        ...base,
        type: "item.updated",
        payload: {
          itemType: "dynamic_tool_call",
          status: rawEvent.status === "completed" ? "completed" : "inProgress",
          title: typeof rawEvent.tool_name === "string" ? rawEvent.tool_name : "Tool",
          detail: typeof rawEvent.output === "string" ? rawEvent.output : undefined,
          data: rawEvent,
        },
        itemId: typeof rawEvent.tool_id === "string" ? RuntimeItemId.makeUnsafe(rawEvent.tool_id) : undefined,
      };

    case "opencode/tool_result":
      return {
        ...base,
        type: "item.completed",
        payload: {
          itemType: "dynamic_tool_call",
          status: rawEvent.status === "error" ? "failed" : "completed",
          title: typeof rawEvent.tool_name === "string" ? rawEvent.tool_name : "Tool",
          detail: typeof rawEvent.output === "string" ? rawEvent.output : undefined,
          data: rawEvent,
        },
        itemId: typeof rawEvent.tool_id === "string" ? RuntimeItemId.makeUnsafe(rawEvent.tool_id) : undefined,
      };

    case "opencode/approval_requested":
      return {
        ...base,
        type: "request.opened",
        payload: {
          requestType: "command_execution_approval",
          detail: typeof rawEvent.message === "string" ? rawEvent.message : "Approval required",
        },
        requestId: typeof rawEvent.requestId === "string" ? RuntimeItemId.makeUnsafe(rawEvent.requestId) : undefined,
      } as any;

    case "opencode/result":
      return {
        ...base,
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: typeof rawEvent.stopReason === "string" ? rawEvent.stopReason : undefined,
        },
      };

    default:
      return null;
  }
}

const makeOpencodeAdapter = () =>
  Effect.gen(function* () {
    const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const manager = new OpencodeCliManager();

    manager.on("event", (rawEvent: Record<string, unknown>) => {
      const canonical = mapOpencodeEventToCanonical(rawEvent);
      if (canonical) {
        Effect.runSync(Queue.offer(eventQueue, canonical));
      }
    });

    const adapter: OpencodeAdapterShape = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "restart-session" },

      startSession: (input) =>
        Effect.tryPromise({
          try: () => {
            const cwd = input.cwd ?? process.cwd();
            const model = input.model ?? "opencode-1";
            const resumeCursor =
              input.resumeCursor && typeof input.resumeCursor === "object" && "sessionId" in input.resumeCursor
                ? { sessionId: String(input.resumeCursor.sessionId) }
                : undefined;

            return manager.startSession({
              threadId: String(input.threadId),
              model,
              cwd,
              resumeCursor,
            });
          },
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: toMessage(cause, "Failed to start Opencode session"),
            }),
        }).pipe(
          Effect.map((context) => ({
            provider: PROVIDER,
            status: "ready" as const,
            runtimeMode: input.runtimeMode ?? "full-access",
            cwd: context.cwd,
            model: context.model,
            threadId: input.threadId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            ...(context.opencodeSessionId ? { resumeCursor: { sessionId: context.opencodeSessionId } } : {}),
          })),
        ),

      sendTurn: (input) =>
        Effect.tryPromise({
          try: () =>
            manager.sendTurn({
              threadId: String(input.threadId),
              text: input.input ?? "",
              model: input.model,
              interactionMode: input.interactionMode,
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: toMessage(cause, "Failed to send Opencode turn"),
            }),
        }).pipe(
          Effect.map((result) => ({
            turnId: TurnId.makeUnsafe(result.turnId),
            threadId: input.threadId,
            ...(result.resumeCursor ? { resumeCursor: result.resumeCursor } : {}),
          })),
        ),

      interruptTurn: (threadId) =>
        Effect.sync(() => {
          manager.interruptTurn(String(threadId));
        }),

      respondToRequest: (threadId, requestId, decision) =>
        Effect.sync(() => {
          manager.respondToRequest(
            String(threadId),
            String(requestId),
            decision === "accept" || decision === "acceptForSession" ? "approved" : "rejected",
          );
        }),

      respondToUserInput: (_threadId, _requestId, _answers) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail: "Opencode does not support standard user input yet.",
          }),
        ),

      stopSession: (threadId) =>
        Effect.sync(() => {
          manager.stopSession(String(threadId));
        }),

      listSessions: () =>
        Effect.sync(() =>
          manager.listSessions().map((context) => ({
            provider: PROVIDER,
            status: context.status === "stopped" ? "closed" : "ready",
            runtimeMode: "full-access",
            cwd: context.cwd,
            model: context.model,
            threadId: ThreadId.makeUnsafe(context.threadId),
            createdAt: nowIso(),
            updatedAt: nowIso(),
            ...(context.opencodeSessionId ? { resumeCursor: { sessionId: context.opencodeSessionId } } : {}),
          })),
        ),

      hasSession: (threadId) => Effect.sync(() => manager.hasSession(String(threadId))),

      readThread: () => Effect.fail(new ProviderAdapterRequestError({ provider: PROVIDER, method: "readThread", detail: "Not supported" })),
      rollbackThread: () => Effect.fail(new ProviderAdapterRequestError({ provider: PROVIDER, method: "rollbackThread", detail: "Not supported" })),

      stopAll: () =>
        Effect.sync(() => {
          manager.stopAll();
        }),

      streamEvents: Stream.fromQueue(eventQueue),
    };

    return adapter;
  });

export const OpencodeAdapterLive = Layer.effect(OpencodeAdapter, makeOpencodeAdapter());
