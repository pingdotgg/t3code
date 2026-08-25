import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
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

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  // Highest event sequence the subscriber has handed to the worker. Events
  // are published after they commit, so a caller that reads latestSequence
  // and waits for this to catch up knows every deletion up to that point is
  // at least enqueued; the worker drain then covers the in-flight ones.
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(
        orchestrationEngine.streamDomainEvents.pipe(
          // Events that landed before the subscription are not replayed, so
          // start the watermark at the current head instead of zero.
          Stream.onStart(orchestrationEngine.latestSequence.pipe(Effect.flatMap(noteSeen))),
        ),
        (event) =>
          (event.type === "thread.deleted" ? worker.enqueue(event) : Effect.void).pipe(
            Effect.andThen(noteSeen(event.sequence)),
          ),
      ),
    );
  });

  const drain: ThreadDeletionReactorShape["drain"] = Effect.gen(function* () {
    const target = yield* orchestrationEngine.latestSequence;
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= target),
      Stream.runHead,
    );
    yield* worker.drain;
  });

  return {
    start,
    drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
