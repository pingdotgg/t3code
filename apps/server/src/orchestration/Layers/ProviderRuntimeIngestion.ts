import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  parseTurnDiffFilesFromUnifiedDiff,
  type TurnDiffFileSummary,
} from "../../checkpointing/Diffs.ts";
import { createLogger } from "../../logger.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";

const providerTurnKey = (sessionId: string, turnId: string) => `${sessionId}:${turnId}`;

type ActivityTone = "thinking" | "tool" | "info" | "error";

interface ThreadActivityInput {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly detail?: string;
  readonly tone: ActivityTone;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly requestKind?: "command" | "file-change";
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function runtimeEventToActivities(event: ProviderRuntimeEvent): ReadonlyArray<ThreadActivityInput> {
  switch (event.type) {
    case "approval.requested":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label:
            event.requestKind === "command"
              ? "Command approval requested"
              : "File-change approval requested",
          ...(event.detail ? { detail: truncateDetail(event.detail) } : {}),
          tone: "tool",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          requestId: event.requestId,
          requestKind: event.requestKind,
        },
      ];
    case "approval.resolved":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label: "Approval resolved",
          tone: "info",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          requestId: event.requestId,
          ...(event.requestKind ? { requestKind: event.requestKind } : {}),
        },
      ];
    case "runtime.error":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label: "Runtime error",
          detail: truncateDetail(event.message),
          tone: "error",
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      ];
    case "checkpoint.captured":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label: "Checkpoint captured",
          tone: "info",
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      ];
    case "tool.completed":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label: `${event.title} complete`,
          ...(event.detail ? { detail: truncateDetail(event.detail) } : {}),
          tone: "tool",
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      ];
    default:
      return [];
  }
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const logger = createLogger("provider-runtime-ingestion");

  const turnMessageIdsByTurnKey = new Map<string, Set<string>>();
  const latestMessageIdByTurnKey = new Map<string, string>();

  const rememberAssistantMessageId = (sessionId: string, turnId: string, messageId: string) => {
    const key = providerTurnKey(sessionId, turnId);
    const existingIds = turnMessageIdsByTurnKey.get(key);
    if (existingIds) {
      existingIds.add(messageId);
    } else {
      turnMessageIdsByTurnKey.set(key, new Set([messageId]));
    }
    latestMessageIdByTurnKey.set(key, messageId);
  };

  const getAssistantMessageIdsForTurn = (sessionId: string, turnId: string) => {
    return turnMessageIdsByTurnKey.get(providerTurnKey(sessionId, turnId)) ?? new Set<string>();
  };

  const clearAssistantMessageIdsForTurn = (sessionId: string, turnId: string) => {
    turnMessageIdsByTurnKey.delete(providerTurnKey(sessionId, turnId));
  };

  const getLatestAssistantMessageIdForTurn = (sessionId: string, turnId: string) => {
    return latestMessageIdByTurnKey.get(providerTurnKey(sessionId, turnId));
  };

  const clearTurnStateForSession = (sessionId: string) => {
    const prefix = `${sessionId}:`;
    for (const key of turnMessageIdsByTurnKey.keys()) {
      if (key.startsWith(prefix)) {
        turnMessageIdsByTurnKey.delete(key);
      }
    }
    for (const key of latestMessageIdByTurnKey.keys()) {
      if (key.startsWith(prefix)) {
        latestMessageIdByTurnKey.delete(key);
      }
    }
  };

  const processEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find(
        (entry) => entry.session?.sessionId === event.sessionId,
      );
      if (!thread) return;

      const now = event.createdAt;
      if (event.type === "turn.started" || event.type === "turn.completed") {
        yield* orchestrationEngine.dispatch({
          type: "thread.session",
          commandId: crypto.randomUUID(),
          threadId: thread.id,
          session: {
            sessionId: event.sessionId,
            provider: event.provider,
            status: event.type === "turn.started" ? "running" : "ready",
            threadId: thread.id,
            activeTurnId: event.type === "turn.started" ? event.turnId : null,
            createdAt: thread.session?.createdAt ?? now,
            updatedAt: now,
            lastError:
              event.type === "turn.completed" && event.status === "failed"
                ? (event.errorMessage ?? null)
                : null,
          },
          createdAt: now,
        });
      }

      if (event.type === "message.delta" && event.delta.length > 0) {
        const assistantMessageId = `assistant:${event.itemId ?? event.turnId ?? event.sessionId}`;
        if (event.turnId) {
          rememberAssistantMessageId(event.sessionId, event.turnId, assistantMessageId);
        }
        yield* orchestrationEngine.dispatch({
          type: "message.send",
          commandId: crypto.randomUUID(),
          threadId: thread.id,
          messageId: assistantMessageId,
          role: "assistant",
          text: event.delta,
          streaming: true,
          createdAt: now,
        });
      }

      if (event.type === "message.completed") {
        const assistantMessageId = `assistant:${event.itemId}`;
        if (event.turnId) {
          rememberAssistantMessageId(event.sessionId, event.turnId, assistantMessageId);
        }
        yield* orchestrationEngine.dispatch({
          type: "message.send",
          commandId: crypto.randomUUID(),
          threadId: thread.id,
          messageId: assistantMessageId,
          role: "assistant",
          text: "",
          streaming: false,
          createdAt: now,
        });
      }

      if (event.type === "turn.completed" && event.turnId) {
        const assistantMessageIds = getAssistantMessageIdsForTurn(event.sessionId, event.turnId);
        yield* Effect.forEach(assistantMessageIds, (assistantMessageId) =>
          orchestrationEngine.dispatch({
            type: "message.send",
            commandId: crypto.randomUUID(),
            threadId: thread.id,
            messageId: assistantMessageId,
            role: "assistant",
            text: "",
            streaming: false,
            createdAt: now,
          }),
        ).pipe(Effect.asVoid);
        clearAssistantMessageIdsForTurn(event.sessionId, event.turnId);
      }

      if (event.type === "session.exited") {
        clearTurnStateForSession(event.sessionId);
      }

      if (event.type === "checkpoint.captured" && event.turnId) {
        const files: ReadonlyArray<TurnDiffFileSummary> = yield* providerService
          .getCheckpointDiff({
            sessionId: event.sessionId,
            fromTurnCount: Math.max(0, event.turnCount - 1),
            toTurnCount: event.turnCount,
          })
          .pipe(
            Effect.map((result) => parseTurnDiffFilesFromUnifiedDiff(result.diff)),
            Effect.catch((error) =>
              Effect.sync(() => {
                logger.warn("failed to derive checkpoint file summary", {
                  sessionId: event.sessionId,
                  turnId: event.turnId,
                  turnCount: event.turnCount,
                  error:
                    error instanceof Error
                      ? error.message
                      : typeof error === "string"
                        ? error
                        : "unknown error",
                });
              }).pipe(Effect.as([] as ReadonlyArray<TurnDiffFileSummary>)),
            ),
          );
        const assistantMessageId =
          getLatestAssistantMessageIdForTurn(event.sessionId, event.turnId) ??
          `assistant:${event.turnId}`;
        yield* orchestrationEngine.dispatch({
          type: "thread.turnDiff.complete",
          commandId: crypto.randomUUID(),
          threadId: thread.id,
          turnId: event.turnId,
          completedAt: now,
          ...(event.status ? { status: event.status } : {}),
          files,
          assistantMessageId,
          checkpointTurnCount: event.turnCount,
          createdAt: now,
        });
      }

      if (event.type === "runtime.error") {
        yield* orchestrationEngine.dispatch({
          type: "thread.session",
          commandId: crypto.randomUUID(),
          threadId: thread.id,
          session: {
            sessionId: event.sessionId,
            provider: event.provider,
            status: "error",
            threadId: thread.id,
            activeTurnId: event.turnId ?? null,
            createdAt: thread.session?.createdAt ?? now,
            updatedAt: now,
            lastError: event.message,
          },
          createdAt: now,
        });
      }

      const activities = runtimeEventToActivities(event);
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: crypto.randomUUID(),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    const providerEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.addFinalizer(() => Queue.shutdown(providerEventQueue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(providerEventQueue).pipe(Effect.flatMap(processEvent))),
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
