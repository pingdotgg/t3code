/**
 * AugmentAdapterLive - Scoped live implementation for the Augment provider adapter.
 *
 * Wraps `AugmentACPManager` behind the `AugmentAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module AugmentAdapterLive
 */
import {
  ProviderApprovalDecision,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Schema, ServiceMap, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { AugmentAdapter, type AugmentAdapterShape } from "../Services/AugmentAdapter.ts";
import {
  AugmentACPManager,
  type AugmentACPStartSessionInput,
} from "../../augmentACPManager.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "augment" as const;

export interface AugmentAdapterLiveOptions {
  readonly manager?: AugmentACPManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => AugmentACPManager;
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
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
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

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

// Map ACP update types to canonical item types
function toCanonicalItemType(updateType: string): CanonicalItemType {
  switch (updateType) {
    case "agent_message_chunk":
      return "assistant_message";
    case "agent_thought_chunk":
      return "reasoning";
    case "tool_call_added":
    case "tool_call_updated":
      return "dynamic_tool_call";
    case "plan_update":
      return "plan";
    default:
      return "unknown";
  }
}

function toCanonicalRequestType(method: string): CanonicalRequestType {
  if (method === "session/request_permission") {
    // ACP permission requests - determine type from payload if available
    return "command_execution_approval";
  }
  return "unknown";
}

function eventRawSource(
  event: ProviderEvent,
): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "augment.acp.request" : "augment.acp.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

/**
 * Maps Augment ACP events to T3 Code's canonical ProviderRuntimeEvent format.
 */
function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);

  // Error events
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  // Permission request events
  if (event.kind === "request") {
    if (event.method === "session/request_permission") {
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "request.opened",
          payload: {
            requestType: toCanonicalRequestType(event.method),
            ...(event.payload !== undefined ? { args: event.payload } : {}),
          },
        },
      ];
    }
    return [];
  }

  // Session lifecycle events
  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/closed" || event.method === "session/exited") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  // Turn lifecycle events
  if (event.method === "turn/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    const stopReason = asString(asObject(event.payload)?.stopReason);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: stopReason === "cancelled" ? "cancelled" : "completed",
        },
      },
    ];
  }

  if (event.method === "turn/failed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: "failed",
          ...(event.message ? { errorMessage: event.message } : {}),
        },
      },
    ];
  }

  // Content streaming events (agent message / thought deltas)
  if (event.method === "item/agentMessage/delta") {
    const delta = event.textDelta ?? asString(payload?.delta) ?? asString(payload?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/agentThought/delta") {
    const delta = event.textDelta ?? asString(payload?.delta) ?? asString(payload?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta,
        },
      },
    ];
  }

  // Tool call events
  if (event.method === "item/toolCall/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started",
        payload: {
          itemType: "dynamic_tool_call",
          status: "inProgress",
          title: "Tool call",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/toolCall/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType: "dynamic_tool_call",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  // Approval decision events
  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decisionOption = Schema.decodeUnknownOption(ProviderApprovalDecision)(payload?.decision);
    const decision = decisionOption._tag === "Some" ? decisionOption.value : undefined;
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType: "command_execution_approval",
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  // Unhandled events - return empty array
  return [];
}

const makeAugmentAdapter = (options?: AugmentAdapterLiveOptions) =>
  Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) {
          return options.manager;
        }
        const services = yield* Effect.services<never>();
        return options?.makeManager?.(services) ?? new AugmentACPManager(services);
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

    const startSession: AugmentAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      const managerInput: AugmentACPStartSessionInput = {
        threadId: input.threadId,
        provider: "augment",
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        runtimeMode: input.runtimeMode,
        ...(input.model !== undefined ? { model: input.model } : {}),
      };

      return Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Augment adapter session."),
            cause,
          }),
      });
    };

    const sendTurn: AugmentAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        // Convert attachments to base64 data URLs if needed
        const augmentAttachments: Array<{ type: "image"; url: string }> = [];
        for (const attachment of input.attachments ?? []) {
          // For now, pass through image attachments directly
          // TODO: Handle attachment file reading if needed
          augmentAttachments.push({
            type: "image",
            url: `attachment:${attachment.id}`,
          });
        }

        return yield* Effect.tryPromise({
          try: () => {
            const managerInput = {
              threadId: input.threadId,
              ...(input.input !== undefined ? { input: input.input } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.interactionMode !== undefined
                ? { interactionMode: input.interactionMode }
                : {}),
              ...(augmentAttachments.length > 0 ? { attachments: augmentAttachments } : {}),
            };
            return manager.sendTurn(managerInput);
          },
          catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
        }).pipe(
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const interruptTurn: AugmentAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(threadId, turnId),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

    // Augment/ACP doesn't support thread reading/rollback yet
    const readThread: AugmentAdapterShape["readThread"] = (threadId) =>
      Effect.succeed({
        threadId,
        turns: [],
      });

    const rollbackThread: AugmentAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
      Effect.succeed({
        threadId,
        turns: [],
      });

    const respondToRequest: AugmentAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(threadId, requestId, decision),
        catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
      });

    // Augment/ACP doesn't support user input prompts yet
    const respondToUserInput: AugmentAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) => Effect.void;

    const stopSession: AugmentAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        manager.stopSession(threadId);
      });

    const listSessions: AugmentAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: AugmentAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const stopAll: AugmentAdapterShape["stopAll"] = () =>
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
              yield* Effect.logDebug("ignoring unhandled Augment provider event", {
                method: event.method,
                threadId: event.threadId,
                turnId: event.turnId,
                itemId: event.itemId,
              });
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
        sessionModelSwitch: "restart-session", // ACP sessions are model-bound
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies AugmentAdapterShape;
  });

export const AugmentAdapterLive = Layer.effect(AugmentAdapter, makeAugmentAdapter());

export function makeAugmentAdapterLive(options?: AugmentAdapterLiveOptions) {
  return Layer.effect(AugmentAdapter, makeAugmentAdapter(options));
}

