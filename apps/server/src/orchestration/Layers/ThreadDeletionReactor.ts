import { type OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { taskWorkbenchId } from "@t3tools/shared/taskWorkbench";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { PreviewManager } from "../../preview/Manager.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type CleanupEvent = Extract<
  OrchestrationEvent,
  { type: "thread.deleted" | "thread.archived" | "task.deleted" | "task.archived" }
>;
type ThreadDeletedEvent = Extract<CleanupEvent, { type: "thread.deleted" }>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: string;
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const previewManager = yield* PreviewManager;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const processCleanup = Effect.fn("ThreadDeletionReactor.processCleanup")(function* (
    event: CleanupEvent,
  ) {
    const threadId =
      event.type === "thread.deleted" || event.type === "thread.archived"
        ? event.payload.threadId
        : taskWorkbenchId(event.payload.taskId);
    if (event.type === "thread.deleted") {
      yield* stopProviderSession(event.payload.threadId);
    }
    yield* logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({
        threadId,
        deleteHistory: event.type === "thread.deleted" || event.type === "task.deleted",
      }),
      message: "resource cleanup skipped terminal close",
      threadId,
    });
    yield* logCleanupCauseUnlessInterrupted({
      effect: previewManager.close({ threadId: ThreadId.make(threadId) }),
      message: "resource cleanup skipped preview close",
      threadId,
    });
  });

  const processCleanupSafely = (event: CleanupEvent) =>
    processCleanup(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          aggregateId: event.aggregateId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processCleanupSafely);

  // Highest event sequence the subscriber has handed to the worker. Waiting
  // through a successful thread.created sequence covers every deletion that
  // was ahead of that create in the engine queue; the worker drain then covers
  // the in-flight cleanup.
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    // Startup keeps commands gated and other roots parked until start returns.
    // Capture the pre-subscription head while commits are still excluded.
    yield* orchestrationEngine.latestSequence.pipe(Effect.flatMap(noteSeen));
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* forkParked(
      Stream.runForEach(domainEvents, (event) =>
        (event.type === "thread.deleted" ||
        event.type === "thread.archived" ||
        event.type === "task.deleted" ||
        event.type === "task.archived"
          ? worker.enqueue(event)
          : Effect.void
        ).pipe(Effect.andThen(noteSeen(event.sequence))),
      ),
    );
  });

  const drainThrough: ThreadDeletionReactorShape["drainThrough"] = Effect.fn(
    "ThreadDeletionReactor.drainThrough",
  )(function* (target) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= target),
      Stream.runHead,
    );
    yield* worker.drain;
  });

  return {
    start,
    drainThrough,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
