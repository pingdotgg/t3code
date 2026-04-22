import Mime from "@effect/platform-node/Mime";
import { makeDrainableWorker } from "@harness/shared/DrainableWorker";
import {
  CommandId,
  EventId,
  type ChatAttachment,
  type OrchestrationEvent,
  ThreadId,
} from "@harness/contracts";
import { basename } from "node:path";
import { statSync } from "node:fs";
import { Cause, Effect, Layer, Stream } from "effect";

import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { TurnQueueReactor, type TurnQueueReactorShape } from "../Services/TurnQueueReactor.ts";
import {
  canPromoteQueuedTurn,
  getHeadQueuedTurn,
  validateSourceProposedPlanReference,
} from "../turnQueue.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

class TurnQueueAttachmentResolutionError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.detail = detail;
    this.name = "TurnQueueAttachmentResolutionError";
  }
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverConfig = yield* ServerConfig;

  const appendPromotionFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("turn-queue-promotion-failed"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: "turn.queue.promotion.failed",
        summary: "Queued turn promotion failed",
        payload: {
          messageId: input.messageId,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const pauseQueue = Effect.fn("pauseQueue")(function* (input: {
    readonly threadId: ThreadId;
    readonly reason: "interrupted" | "error";
    readonly createdAt: string;
  }) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread || thread.turnQueue.items.length === 0) {
      return;
    }
    if (thread.turnQueue.status === "paused" && thread.turnQueue.pauseReason === input.reason) {
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.queue.pause",
      commandId: serverCommandId("turn-queue-pause"),
      threadId: input.threadId,
      reason: input.reason,
      createdAt: input.createdAt,
    });
  });

  const resolveQueuedTurnAttachments = Effect.fn("resolveQueuedTurnAttachments")(function* (input: {
    readonly attachmentIds: ReadonlyArray<string>;
  }) {
    return yield* Effect.forEach(
      input.attachmentIds,
      (attachmentId) =>
        Effect.try({
          try: () => {
            const filePath = resolveAttachmentPathById({
              attachmentsDir: serverConfig.attachmentsDir,
              attachmentId,
            });
            if (!filePath) {
              throw new TurnQueueAttachmentResolutionError(
                `Attachment '${attachmentId}' is unavailable.`,
              );
            }
            const mimeType = Mime.getType(filePath) ?? "application/octet-stream";
            if (!mimeType.startsWith("image/")) {
              throw new TurnQueueAttachmentResolutionError(
                `Attachment '${attachmentId}' is not a supported image.`,
              );
            }
            return {
              type: "image" as const,
              id: attachmentId,
              name: basename(filePath),
              mimeType,
              sizeBytes: statSync(filePath).size,
            } satisfies ChatAttachment;
          },
          catch: (error) =>
            error instanceof TurnQueueAttachmentResolutionError
              ? error
              : new TurnQueueAttachmentResolutionError(String(error)),
        }),
      { concurrency: 1 },
    );
  });

  const pauseQueueWithFailureActivity = Effect.fn("pauseQueueWithFailureActivity")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly messageId: string;
      readonly detail: string;
      readonly createdAt: string;
    }) {
      yield* pauseQueue({
        threadId: input.threadId,
        reason: "error",
        createdAt: input.createdAt,
      });
      yield* appendPromotionFailureActivity(input);
    },
  );

  const maybePromoteHead = Effect.fn("maybePromoteHead")(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread || !canPromoteQueuedTurn(thread)) {
      return;
    }

    const headQueuedTurn = getHeadQueuedTurn(thread);
    if (!headQueuedTurn) {
      return;
    }

    const promotedAt = new Date().toISOString();
    const validated = yield* Effect.exit(
      validateSourceProposedPlanReference({
        readModel,
        commandType: "thread.turn.queue.promote",
        targetThread: thread,
        sourceProposedPlan: headQueuedTurn.sourceProposedPlan,
      }),
    );
    if (validated._tag === "Failure") {
      const detail = Cause.pretty(validated.cause);
      yield* pauseQueueWithFailureActivity({
        threadId,
        messageId: headQueuedTurn.messageId,
        detail,
        createdAt: promotedAt,
      });
      return;
    }

    const attachments = yield* resolveQueuedTurnAttachments({
      attachmentIds: headQueuedTurn.attachmentIds,
    }).pipe(Effect.exit);
    if (attachments._tag === "Failure") {
      yield* pauseQueueWithFailureActivity({
        threadId,
        messageId: headQueuedTurn.messageId,
        detail: Cause.pretty(attachments.cause),
        createdAt: promotedAt,
      });
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.queue.promote",
      commandId: serverCommandId("turn-queue-promote"),
      threadId,
      messageId: headQueuedTurn.messageId,
      ...(attachments.value.length > 0 ? { attachments: attachments.value } : {}),
      promotedAt,
      createdAt: promotedAt,
    });
  });

  const reconcileQueuedThreadsOnStartup = Effect.fn("reconcileQueuedThreadsOnStartup")(
    function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      yield* Effect.forEach(
        readModel.threads.filter(canPromoteQueuedTurn),
        (thread) => maybePromoteHead(thread.id),
        { concurrency: 1 },
      );
    },
  );

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    switch (event.type) {
      case "thread.turn-enqueued":
      case "thread.turn-queue-resumed":
        yield* maybePromoteHead(event.payload.threadId);
        return;

      case "thread.turn-queue-item-removed":
        if (event.payload.reason === "removed") {
          yield* maybePromoteHead(event.payload.threadId);
        }
        return;

      case "thread.turn-settled":
        if (event.payload.outcome === "completed") {
          yield* maybePromoteHead(event.payload.threadId);
          return;
        }
        yield* pauseQueue({
          threadId: event.payload.threadId,
          reason: event.payload.outcome === "error" ? "error" : "interrupted",
          createdAt: event.payload.settledAt,
        });
        return;

      case "thread.activity-appended":
        if (event.payload.activity.kind !== "provider.turn.start.failed") {
          return;
        }
        yield* pauseQueue({
          threadId: event.payload.threadId,
          reason: "error",
          createdAt: event.payload.activity.createdAt,
        });
        return;

      default:
        return;
    }
  });

  const processDomainEventSafely = (event: OrchestrationEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("turn queue reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const logTurnQueueFailure = (input: {
    readonly cause: Cause.Cause<unknown>;
    eventType: string;
  }) =>
    Effect.logWarning("turn queue reactor failed to process event", {
      eventType: input.eventType,
      cause: Cause.pretty(input.cause),
    });

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: TurnQueueReactorShape["start"] = Effect.fn("start")(function* () {
    yield* reconcileQueuedThreadsOnStartup().pipe(
      Effect.catchCause((cause) =>
        logTurnQueueFailure({
          eventType: "startup.reconcile",
          cause,
        }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-enqueued" &&
          event.type !== "thread.turn-queue-item-removed" &&
          event.type !== "thread.turn-queue-resumed" &&
          event.type !== "thread.turn-settled" &&
          event.type !== "thread.activity-appended"
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies TurnQueueReactorShape;
});

export const TurnQueueReactorLive = Layer.effect(TurnQueueReactor, make);
