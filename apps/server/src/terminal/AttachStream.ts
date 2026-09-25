import {
  TerminalAttachTimeoutError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as TerminalManager from "./Manager.ts";

/** Preserve ordered output under backpressure; disconnect consumers that stop draining. */
export function terminalAttachStream(input: TerminalAttachInput) {
  return Stream.callback<TerminalAttachStreamEvent, TerminalError, TerminalManager.TerminalManager>(
    (queue) =>
      Effect.gen(function* () {
        const manager = yield* TerminalManager.TerminalManager;
        const stalled = yield* Deferred.make<void>();
        const deliver = (event: TerminalAttachStreamEvent) =>
          Effect.suspend(() => {
            if (Queue.offerUnsafe(queue, event)) return Effect.void;
            return Queue.offer(queue, event).pipe(
              Effect.timeoutOption("30 seconds"),
              Effect.flatMap((offered) => {
                if (Option.isSome(offered)) return Effect.void;
                return Effect.gen(function* () {
                  yield* Queue.fail(
                    queue,
                    new TerminalAttachTimeoutError({
                      threadId: input.threadId,
                      terminalId: input.terminalId,
                    }),
                  );
                  // The timed-out offer is already interrupted. Closing its
                  // queue must not race the timeout and cancel this cleanup.
                  yield* Queue.shutdown(queue);
                  yield* Deferred.succeed(stalled, undefined);
                });
              }),
            );
          });
        return yield* Effect.gen(function* () {
          yield* Effect.acquireRelease(
            manager.attachStream(input, deliver).pipe(Effect.interruptible),
            (unsubscribe) => Effect.sync(unsubscribe),
          );
          return yield* Effect.never;
        }).pipe(
          Effect.scoped,
          Effect.raceFirst(Deferred.await(stalled)),
          Effect.catchCause((cause) =>
            Queue.failCause(queue, cause).pipe(Effect.andThen(Queue.shutdown(queue))),
          ),
        );
      }),
    { bufferSize: 32, strategy: "suspend" },
  );
}
