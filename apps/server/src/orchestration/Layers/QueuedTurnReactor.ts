import { CommandId, QueuedTurnId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { Cause, Effect, Layer, Stream } from "effect";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { QueuedTurnReactor, type QueuedTurnReactorShape } from "../Services/QueuedTurnReactor.ts";
import { isThreadReadyForQueuedDispatch } from "../commandInvariants.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

function threadIdForEvent(event: OrchestrationEvent): ThreadId | null {
  return event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
}

const makeQueuedTurnReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const drainingThreadIds = new Set<string>();

  const failQueuedTurn = (input: {
    readonly threadId: ThreadId;
    readonly queuedTurnId: QueuedTurnId;
    readonly detail: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.queued-turn.fail",
      commandId: serverCommandId("queued-turn.fail"),
      threadId: input.threadId,
      queuedTurnId: input.queuedTurnId,
      failureMessage: input.detail.length > 0 ? input.detail : "Failed to dispatch queued message.",
      failedAt: new Date().toISOString(),
    });

  const drainThread = Effect.fn("QueuedTurnReactor.drainThread")(function* (threadId: ThreadId) {
    if (drainingThreadIds.has(threadId)) {
      return;
    }
    drainingThreadIds.add(threadId);
    try {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      const queuedTurns = thread?.queuedTurns ?? [];
      if (!thread || queuedTurns.length === 0 || !isThreadReadyForQueuedDispatch(thread)) {
        return;
      }

      const nextQueuedTurn = queuedTurns[0];
      if (!nextQueuedTurn || nextQueuedTurn.failedAt !== null) {
        return;
      }

      const dispatchedAt = new Date().toISOString();
      yield* orchestrationEngine
        .dispatch({
          type: "thread.queued-turn.dispatch",
          commandId: serverCommandId("queued-turn.dispatch"),
          threadId,
          queuedTurnId: nextQueuedTurn.id,
          dispatchedAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const latestReadModel = yield* orchestrationEngine.getReadModel();
              const latestThread = latestReadModel.threads.find((entry) => entry.id === threadId);
              if (!latestThread || !isThreadReadyForQueuedDispatch(latestThread)) {
                return;
              }
              yield* failQueuedTurn({
                threadId,
                queuedTurnId: nextQueuedTurn.id,
                detail: Cause.pretty(cause),
              }).pipe(
                Effect.catchCause((failCause) =>
                  Effect.logWarning("failed to mark queued turn as failed", {
                    threadId,
                    queuedTurnId: nextQueuedTurn.id,
                    cause: Cause.pretty(failCause),
                  }),
                ),
              );
            }),
          ),
        );
    } finally {
      drainingThreadIds.delete(threadId);
    }
  });

  const drainThreadSafely = (threadId: ThreadId) =>
    drainThread(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn reactor failed to drain thread", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: QueuedTurnReactorShape["start"] = Effect.fn("start")(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(
      readModel.threads.filter((thread) => (thread.queuedTurns ?? []).length > 0),
      (thread) => drainThreadSafely(thread.id).pipe(Effect.forkScoped),
      { concurrency: 1 },
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const threadId = threadIdForEvent(event);
        return threadId === null ? Effect.void : drainThreadSafely(threadId);
      }),
    );
  });

  return { start } satisfies QueuedTurnReactorShape;
});

export const QueuedTurnReactorLive = Layer.effect(QueuedTurnReactor, makeQueuedTurnReactor);
