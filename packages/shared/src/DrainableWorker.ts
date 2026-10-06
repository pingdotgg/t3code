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
import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

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
 * the scope closes. A finalizer shuts down the queue and drops queued items,
 * so `drain` resolves after the scope closes instead of waiting on them.
 *
 * An item that fails or dies is logged and skipped; the worker keeps
 * processing later items and `drain` still resolves.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `enqueue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const outstanding = yield* TxRef.make(0);
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), (queue) =>
      // Uncount only the dropped items: an item still running uncounts itself,
      // even when a parallel scope closes it after this finalizer.
      TxQueue.clear(queue).pipe(
        Effect.flatMap((dropped) => TxRef.update(outstanding, (n) => n - dropped.length)),
        Effect.andThen(TxQueue.shutdown(queue)),
        Effect.tx,
      ),
    );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((a) =>
        // `suspend` turns a `process` that throws while building its effect
        // into this item's defect instead of the loop's.
        Effect.suspend(() => process(a)).pipe(
          // Only the item's own failure, defect, or interruption lands here and
          // the loop continues; interrupting the worker fiber still stops it.
          // Callers treat an item that only interrupted itself as cancelled,
          // not failed.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("DrainableWorker item failed", cause),
          ),
          Effect.ensuring(TxRef.update(outstanding, (n) => n - 1)),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.flatMap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        // A shut-down queue refuses the item, so it is never processed.
        Effect.tap((offered) => (offered ? TxRef.update(outstanding, (n) => n + 1) : Effect.void)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
