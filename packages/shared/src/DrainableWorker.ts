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
import { Deferred, Effect, Queue, Ref } from "effect";
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
    const initialIdle = yield* Deferred.make<void>();
    yield* Deferred.succeed(initialIdle, undefined).pipe(Effect.orDie);
    const state = yield* Ref.make({
      outstanding: 0,
      idle: initialIdle,
    });

    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    const finishOne = Ref.modify(state, (current) => {
      const remaining = Math.max(0, current.outstanding - 1);
      return [
        remaining === 0 ? current.idle : null,
        {
          outstanding: remaining,
          idle: current.idle,
        },
      ] as const;
    }).pipe(
      Effect.flatMap((idle) =>
        idle === null ? Effect.void : Deferred.succeed(idle, undefined).pipe(Effect.orDie),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((item) => process(item).pipe(Effect.ensuring(finishOne))),
        ),
      ),
    );

    const enqueue: DrainableWorker<A>["enqueue"] = (item) =>
      Effect.gen(function* () {
        const nextIdle = yield* Deferred.make<void>();
        yield* Ref.update(state, (current) =>
          current.outstanding === 0
            ? {
                outstanding: 1,
                idle: nextIdle,
              }
            : {
                outstanding: current.outstanding + 1,
                idle: current.idle,
              },
        );

        const accepted = yield* Queue.offer(queue, item);
        if (!accepted) {
          yield* finishOne;
        }
      });

    const drain: DrainableWorker<A>["drain"] = Ref.get(state).pipe(
      Effect.flatMap(({ idle }) => Deferred.await(idle)),
    );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
