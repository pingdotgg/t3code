import {
  type AssistantDeliveryMode,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  ProviderThreadId,
  type ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Queue, Ref, Stream } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";

const providerTurnKey = (sessionId: ProviderSessionId, turnId: TurnId) => `${sessionId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_ASSISTANT_MESSAGE_SPILLED_CACHE_CAPACITY = 20_000;
const BUFFERED_ASSISTANT_MESSAGE_SPILLED_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

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

  const assistantDeliveryModeRef = yield* Ref.make<AssistantDeliveryMode>(
    DEFAULT_ASSISTANT_DELIVERY_MODE,
  );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });
  const bufferedAssistantMessageSpilledByMessageId = yield* Cache.make<MessageId, true>({
    capacity: BUFFERED_ASSISTANT_MESSAGE_SPILLED_CACHE_CAPACITY,
    timeToLive: BUFFERED_ASSISTANT_MESSAGE_SPILLED_TTL,
    lookup: () => Effect.succeed(true),
  });

  const rememberAssistantMessageId = (
    sessionId: ProviderSessionId,
    turnId: TurnId,
    messageId: MessageId,
  ) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(sessionId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (
    sessionId: ProviderSessionId,
    turnId: TurnId,
    messageId: MessageId,
  ) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (sessionId: ProviderSessionId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (sessionId: ProviderSessionId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(sessionId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: spill full buffered text as a persisted assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const markBufferedAssistantMessageSpilled = (messageId: MessageId) =>
    Cache.set(bufferedAssistantMessageSpilledByMessageId, messageId, true);

  const takeBufferedAssistantMessageSpilled = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantMessageSpilledByMessageId, messageId).pipe(
      Effect.flatMap((spilled) =>
        Cache.invalidate(bufferedAssistantMessageSpilledByMessageId, messageId).pipe(
          Effect.as(Option.isSome(spilled)),
        ),
      ),
    );

  const clearBufferedAssistantMessageSpilled = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantMessageSpilledByMessageId, messageId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    Effect.all(
      [clearBufferedAssistantText(messageId), clearBufferedAssistantMessageSpilled(messageId)],
      { concurrency: 1 },
    ).pipe(Effect.asVoid);

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    spillRemainderCommandTag: string;
  }) =>
    Effect.gen(function* () {
      const text = yield* takeBufferedAssistantText(input.messageId);
      const spilled = yield* takeBufferedAssistantMessageSpilled(input.messageId);

      if (spilled && text.length > 0) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, input.spillRemainderCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        text: spilled ? "" : text,
        createdAt: input.createdAt,
      });
      yield* clearAssistantMessageState(input.messageId);
    });

  const clearTurnStateForSession = (sessionId: ProviderSessionId) =>
    Effect.gen(function* () {
      const prefix = `${sessionId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
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
        const activeTurnId = event.type === "turn.started" ? (toTurnId(event.turnId) ?? null) : null;
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
          yield* rememberAssistantMessageId(event.sessionId, turnId, assistantMessageId);
        }

        const assistantDeliveryMode = yield* Ref.get(assistantDeliveryModeRef);
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, event.delta);
          if (spillChunk.length > 0) {
            yield* markBufferedAssistantMessageSpilled(assistantMessageId);
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
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
      }

      if (event.type === "message.completed") {
        const assistantMessageId = MessageId.makeUnsafe(`assistant:${event.itemId}`);
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(event.sessionId, turnId, assistantMessageId);
        }

        yield* finalizeAssistantMessage({
          event,
          threadId: thread.id,
          messageId: assistantMessageId,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
          commandTag: "assistant-complete",
          spillRemainderCommandTag: "assistant-delta-buffer-remainder",
        });

        if (turnId) {
          yield* forgetAssistantMessageId(event.sessionId, turnId, assistantMessageId);
        }
      }

      if (event.type === "turn.completed") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(event.sessionId, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              Effect.gen(function* () {
                yield* finalizeAssistantMessage({
                  event,
                  threadId: thread.id,
                  messageId: assistantMessageId,
                  turnId,
                  createdAt: now,
                  commandTag: "assistant-complete-finalize",
                  spillRemainderCommandTag: "assistant-delta-buffer-remainder-finalize",
                });
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(event.sessionId, turnId);
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(event.sessionId);
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

  const processDomainEvent = (event: TurnStartRequestedDomainEvent) =>
    Ref.set(
      assistantDeliveryModeRef,
      event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
    );

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    const inputQueue = yield* Queue.unbounded<RuntimeIngestionInput>();
    yield* Effect.addFinalizer(() => Queue.shutdown(inputQueue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(inputQueue).pipe(Effect.flatMap(processInputSafely))),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        Queue.offer(inputQueue, { source: "runtime", event }).pipe(Effect.asVoid),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return Queue.offer(inputQueue, { source: "domain", event }).pipe(Effect.asVoid);
      }),
    );
  });

  return {
    start,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(ProviderRuntimeIngestionService, make);
