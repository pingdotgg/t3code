import {
  CommandId,
  MessageId,
  ProviderThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Queue, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";

const providerTurnKey = (sessionId: ProviderSessionId, turnId: TurnId) => `${sessionId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

function toTurnId(value: string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(value);
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  switch (event.type) {
    case "approval.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            event.requestKind === "command"
              ? "Command approval requested"
              : "File-change approval requested",
          payload: {
            requestId: event.requestId,
            requestKind: event.requestKind,
            ...(event.detail ? { detail: truncateDetail(event.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "approval.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: event.requestId,
            ...(event.requestKind ? { requestKind: event.requestKind } : {}),
            ...(event.decision ? { decision: event.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }
    case "tool.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: `${event.title} complete`,
          payload: {
            toolKind: event.toolKind,
            ...(event.detail ? { detail: truncateDetail(event.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }
    case "tool.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.title} started`,
          payload: {
            toolKind: event.toolKind,
            ...(event.detail ? { detail: truncateDetail(event.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
        },
      ];
    }

    default:
      return [];
  }
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const turnMessageIdsByTurnKey = new Map<string, Set<MessageId>>();

  const rememberAssistantMessageId = (
    sessionId: ProviderSessionId,
    turnId: TurnId,
    messageId: MessageId,
  ) => {
    const key = providerTurnKey(sessionId, turnId);
    const existingIds = turnMessageIdsByTurnKey.get(key);
    if (existingIds) {
      existingIds.add(messageId);
    } else {
      turnMessageIdsByTurnKey.set(key, new Set([messageId]));
    }
  };

  const forgetAssistantMessageId = (
    sessionId: ProviderSessionId,
    turnId: TurnId,
    messageId: MessageId,
  ) => {
    const key = providerTurnKey(sessionId, turnId);
    const existingIds = turnMessageIdsByTurnKey.get(key);
    if (!existingIds) {
      return;
    }
    existingIds.delete(messageId);
    if (existingIds.size === 0) {
      turnMessageIdsByTurnKey.delete(key);
    }
  };

  const getAssistantMessageIdsForTurn = (sessionId: ProviderSessionId, turnId: TurnId) => {
    return turnMessageIdsByTurnKey.get(providerTurnKey(sessionId, turnId)) ?? new Set<MessageId>();
  };

  const clearAssistantMessageIdsForTurn = (sessionId: ProviderSessionId, turnId: TurnId) => {
    turnMessageIdsByTurnKey.delete(providerTurnKey(sessionId, turnId));
  };

  const clearTurnStateForSession = (sessionId: ProviderSessionId) => {
    const prefix = `${sessionId}:`;
    for (const key of turnMessageIdsByTurnKey.keys()) {
      if (key.startsWith(prefix)) {
        turnMessageIdsByTurnKey.delete(key);
      }
    }
  };

  const processEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find(
        (entry) => entry.session?.providerSessionId === event.sessionId,
      );
      if (!thread) return;

      const now = event.createdAt;

      if (
        event.type === "session.started" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const activeTurnId =
          event.type === "turn.started" ? (toTurnId(event.turnId) ?? null) : null;
        const providerThreadIdFromEvent =
          event.type === "thread.started"
            ? ProviderThreadId.makeUnsafe(event.threadId)
            : event.threadId !== undefined
              ? ProviderThreadId.makeUnsafe(event.threadId)
              : null;
        const providerThreadId =
          providerThreadIdFromEvent ?? thread.session?.providerThreadId ?? null;
        const status =
          event.type === "turn.started"
            ? "running"
            : event.type === "session.exited"
              ? "stopped"
              : event.type === "turn.completed" && event.status === "failed"
                ? "error"
                : "ready";
        const lastError =
          event.type === "turn.completed" && event.status === "failed"
            ? (event.errorMessage ?? thread.session?.lastError ?? "Turn failed")
            : status === "ready"
              ? null
              : (thread.session?.lastError ?? null);

        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "thread-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status,
            providerName: event.provider,
            providerSessionId: event.sessionId,
            providerThreadId,
            activeTurnId,
            lastError,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      if (event.type === "message.delta" && event.delta.length > 0) {
        const assistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.sessionId}`,
        );
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          rememberAssistantMessageId(event.sessionId, turnId, assistantMessageId);
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(event, "assistant-delta"),
          threadId: thread.id,
          messageId: assistantMessageId,
          delta: event.delta,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
        });
      }

      if (event.type === "message.completed") {
        const assistantMessageId = MessageId.makeUnsafe(`assistant:${event.itemId}`);
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          rememberAssistantMessageId(event.sessionId, turnId, assistantMessageId);
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: providerCommandId(event, "assistant-complete"),
          threadId: thread.id,
          messageId: assistantMessageId,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
        });

        if (turnId) {
          forgetAssistantMessageId(event.sessionId, turnId, assistantMessageId);
        }
      }

      if (event.type === "turn.completed") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const assistantMessageIds = getAssistantMessageIdsForTurn(event.sessionId, turnId);
          yield* Effect.forEach(assistantMessageIds, (assistantMessageId) =>
            orchestrationEngine.dispatch({
              type: "thread.message.assistant.complete",
              commandId: providerCommandId(event, "assistant-complete-finalize"),
              threadId: thread.id,
              messageId: assistantMessageId,
              turnId,
              createdAt: now,
            }),
          ).pipe(Effect.asVoid);
          clearAssistantMessageIdsForTurn(event.sessionId, turnId);
        }
      }

      if (event.type === "session.exited") {
        clearTurnStateForSession(event.sessionId);
      }

      if (event.type === "runtime.error") {
        const providerThreadId =
          event.threadId !== undefined
            ? ProviderThreadId.makeUnsafe(event.threadId)
            : (thread.session?.providerThreadId ?? null);

        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "runtime-error-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "error",
            providerName: event.provider,
            providerSessionId: event.sessionId,
            providerThreadId,
            activeTurnId: toTurnId(event.turnId) ?? null,
            lastError: event.message,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      const activities = runtimeEventToActivities(event);
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append"),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const processEventSafely = (event: ProviderRuntimeEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          eventId: event.eventId,
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    const providerEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.addFinalizer(() => Queue.shutdown(providerEventQueue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(providerEventQueue).pipe(Effect.flatMap(processEventSafely))),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        Queue.offer(providerEventQueue, event).pipe(Effect.asVoid),
      ),
    );
  });

  return {
    start,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(ProviderRuntimeIngestionService, make);
