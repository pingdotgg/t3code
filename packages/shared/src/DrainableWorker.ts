import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  readonly enqueue: (item: A) => Effect.Effect<void>;

  readonly drain: Effect.Effect<void>;
}

/**
 * A finalizer shuts down the queue and drops queued items, so `drain` resolves after the scope
 * closes instead of waiting on them. An item that fails or dies is logged and skipped; the worker
 * keeps processing later items and `drain` still resolves.
 */
export const makeDrainableWorker = Effect.fn("DrainableWorker.makeDrainableWorker")(function* <
  A,
  E,
  R,
>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.fn.Return<DrainableWorker<A>, never, Scope.Scope | R> {
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
      Effect.tap((offered) => (offered ? TxRef.update(outstanding, (n) => n + 1) : Effect.void)),
      Effect.tx,
    );

  return { enqueue, drain } satisfies DrainableWorker<A>;
});
