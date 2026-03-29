/**
 * DrainableWorker - A queue-based worker with deterministic `drain()`.
 *
 * Tracks outstanding work in STM so `drain()` resolves only when no items
 * are queued or in flight. Useful in tests instead of timing-based waits.
 *
 * @module DrainableWorker
 */
import { Effect, TxQueue, TxRef } from "effect";
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
    const ref = yield* TxRef.make(0);

    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), (queue) =>
      TxQueue.shutdown(queue),
    );

    const takeItem = Effect.tx(
      Effect.gen(function* () {
        const item = yield* TxQueue.take(queue);
        yield* TxRef.update(ref, (n) => n + 1);
        return item;
      }),
    );

    yield* takeItem.pipe(
      Effect.flatMap((item) =>
        process(item).pipe(Effect.ensuring(TxRef.update(ref, (n) => n - 1))),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = Effect.tx(
      Effect.gen(function* () {
        const inFlight = yield* TxRef.get(ref);
        const isEmpty = yield* TxQueue.isEmpty(queue);
        if (inFlight > 0 || !isEmpty) {
          return yield* Effect.txRetry;
        }
      }),
    );

    return {
      enqueue: (item) => TxQueue.offer(queue, item),
      drain,
    } satisfies DrainableWorker<A>;
  });
