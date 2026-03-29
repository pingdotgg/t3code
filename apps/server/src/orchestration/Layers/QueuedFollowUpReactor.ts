import { CommandId, MessageId, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  buildQueuedFollowUpMessageText,
  canDispatchQueuedFollowUp,
} from "@t3tools/shared/orchestration";
import { Cause, Effect, Exit, Layer, Stream } from "effect";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  QueuedFollowUpReactor,
  type QueuedFollowUpReactorShape,
} from "../Services/QueuedFollowUpReactor.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const inFlightFollowUpIds = new Set<string>();
  const pendingQueuedDispatchByThreadId = new Map<ThreadId, string>();
  const blockedQueuedFollowUpIdsByThreadId = new Map<ThreadId, string>();

  const hasQueuedDispatchSettled = Effect.fnUntraced(function* (threadId: ThreadId) {
    const dispatchedAt = pendingQueuedDispatchByThreadId.get(threadId);
    if (!dispatchedAt) {
      return true;
    }
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find(
      (entry) => entry.id === threadId && entry.deletedAt === null,
    );
    if (!thread) {
      return true;
    }
    if (thread.session?.status === "starting" || thread.session?.status === "running") {
      return false;
    }
    if (thread.latestTurn && thread.latestTurn.requestedAt >= dispatchedAt) {
      return thread.latestTurn.completedAt !== null;
    }
    return thread.activities.some(
      (activity) =>
        activity.createdAt >= dispatchedAt && activity.kind === "provider.turn.start.failed",
    );
  });

  const processThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find(
      (entry) => entry.id === threadId && entry.deletedAt === null,
    );
    if (!thread) {
      pendingQueuedDispatchByThreadId.delete(threadId);
      blockedQueuedFollowUpIdsByThreadId.delete(threadId);
      return;
    }
    const blockedFollowUpId = blockedQueuedFollowUpIdsByThreadId.get(threadId);
    if (blockedFollowUpId) {
      const blockedQueuedFollowUpStillPresent = thread.queuedFollowUps.some(
        (followUp) => followUp.id === blockedFollowUpId,
      );
      if (blockedQueuedFollowUpStillPresent) {
        return;
      }
      blockedQueuedFollowUpIdsByThreadId.delete(threadId);
    }
    if (pendingQueuedDispatchByThreadId.has(threadId)) {
      const settled = yield* hasQueuedDispatchSettled(threadId);
      if (!settled) {
        return;
      }
      pendingQueuedDispatchByThreadId.delete(threadId);
    }
    const queuedHead = thread.queuedFollowUps[0];
    if (!queuedHead) {
      return;
    }
    if (
      !canDispatchQueuedFollowUp({
        session: thread.session,
        activities: thread.activities,
        queuedFollowUpCount: thread.queuedFollowUps.length,
        queuedHeadHasError: queuedHead.lastSendError !== null,
      })
    ) {
      return;
    }
    if (inFlightFollowUpIds.has(queuedHead.id)) {
      return;
    }

    inFlightFollowUpIds.add(queuedHead.id);
    yield* Effect.gen(function* () {
      const blockQueuedFollowUpAfterPersistenceFailure = Effect.fnUntraced(function* () {
        blockedQueuedFollowUpIdsByThreadId.set(threadId, queuedHead.id);
        yield* Effect.logWarning(
          "queued follow-up reactor blocked a queued item after persistence failure",
          {
            threadId,
            followUpId: queuedHead.id,
          },
        );
      });

      const turnStartCreatedAt = new Date().toISOString();
      const turnStartExit = yield* Effect.exit(
        orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: serverCommandId("queued-follow-up-turn-start"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe(crypto.randomUUID()),
            role: "user",
            text: buildQueuedFollowUpMessageText({
              prompt: queuedHead.prompt,
              terminalContexts: queuedHead.terminalContexts,
              attachmentCount: queuedHead.attachments.length,
            }),
            attachments: queuedHead.attachments,
          },
          modelSelection: queuedHead.modelSelection,
          runtimeMode: queuedHead.runtimeMode,
          interactionMode: queuedHead.interactionMode,
          createdAt: turnStartCreatedAt,
        }),
      );

      if (Exit.isFailure(turnStartExit)) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.queued-follow-up.send-failed",
            commandId: serverCommandId("queued-follow-up-send-failed"),
            threadId,
            followUpId: queuedHead.id,
            lastSendError: Cause.pretty(turnStartExit.cause),
            createdAt: new Date().toISOString(),
          })
          .pipe(
            Effect.catchCause((nestedCause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "queued follow-up reactor failed to persist send failure",
                  {
                    threadId,
                    followUpId: queuedHead.id,
                    cause: Cause.pretty(nestedCause),
                  },
                );
                yield* blockQueuedFollowUpAfterPersistenceFailure();
              }),
            ),
          );
        return;
      }

      pendingQueuedDispatchByThreadId.set(threadId, turnStartCreatedAt);
      const removeExit = yield* Effect.exit(
        orchestrationEngine.dispatch({
          type: "thread.queued-follow-up.remove",
          commandId: serverCommandId("queued-follow-up-remove"),
          threadId,
          followUpId: queuedHead.id,
          createdAt: new Date().toISOString(),
        }),
      );

      if (Exit.isFailure(removeExit)) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.queued-follow-up.send-failed",
            commandId: serverCommandId("queued-follow-up-send-failed"),
            threadId,
            followUpId: queuedHead.id,
            lastSendError: "Queued follow-up was sent but queue cleanup failed.",
            createdAt: new Date().toISOString(),
          })
          .pipe(
            Effect.catchCause((nestedCause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "queued follow-up reactor failed to persist send failure",
                  {
                    threadId,
                    followUpId: queuedHead.id,
                    cause: Cause.pretty(nestedCause),
                  },
                );
                yield* blockQueuedFollowUpAfterPersistenceFailure();
              }),
            ),
          );
      }
    }).pipe(Effect.ensuring(Effect.sync(() => inFlightFollowUpIds.delete(queuedHead.id))));
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    processThread(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("queued follow-up reactor failed to process thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const enqueueThread = (threadId: ThreadId) => worker.enqueue(threadId);

  const start: QueuedFollowUpReactorShape["start"] = Effect.gen(function* () {
    const snapshot = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(
      snapshot.threads,
      (thread) =>
        thread.deletedAt === null && thread.queuedFollowUps.length > 0
          ? enqueueThread(thread.id)
          : Effect.void,
      { concurrency: 1 },
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event: OrchestrationEvent) => {
        if (event.aggregateKind !== "thread") {
          return Effect.void;
        }
        return enqueueThread(event.aggregateId as ThreadId);
      }),
    );
  }).pipe(Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies QueuedFollowUpReactorShape;
});

export const QueuedFollowUpReactorLive = Layer.effect(QueuedFollowUpReactor, make);
