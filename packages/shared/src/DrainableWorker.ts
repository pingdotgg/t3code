/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import { Effect, Queue, Ref, Schedule } from "effect";
import type { Scope } from "effect";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   *
   * Uses a tight `Schedule.spaced("1 millis")` poll which resolves in
   * microseconds in practice — intended for test use only.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<A>();
    const outstanding = yield* Ref.make(0);

    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((item) =>
            process(item).pipe(
              Effect.ensuring(Ref.update(outstanding, (count) => Math.max(0, count - 1))),
            ),
          ),
        ),
      ),
    );

    const enqueue: DrainableWorker<A>["enqueue"] = (item) =>
      Ref.update(outstanding, (count) => count + 1).pipe(
        Effect.flatMap(() => Queue.offer(queue, item)),
        Effect.flatMap((accepted) =>
          accepted === false
            ? Ref.update(outstanding, (count) => Math.max(0, count - 1))
            : Effect.void,
        ),
        Effect.asVoid,
      );

    const drain: DrainableWorker<A>["drain"] = Ref.get(outstanding).pipe(
      Effect.repeat({
        while: (count) => count > 0,
        schedule: Schedule.spaced("1 millis"),
      }),
      Effect.asVoid,
    );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
