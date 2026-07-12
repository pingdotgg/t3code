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
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals. Resolves
   * `true` when the item was accepted and `false` when the queue is shut
   * down (the item is dropped and drain state is left untouched).
   */
  readonly enqueue: (item: A) => Effect.Effect<boolean>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

export interface KeyedDrainableWorker<K, A, R = never> {
  /**
   * Enqueue a work item on the worker dedicated to `key`.
   *
   * Items for the same key are processed in order, while different keys have
   * independent worker fibers.
   */
  readonly enqueue: (key: K, item: A) => Effect.Effect<void, never, R>;

  /**
   * Resolves when every item enqueued on every key has finished processing.
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
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        // `TxQueue.offer` resolves `false` (instead of failing) on a closing
        // or shut-down queue; only track items the queue actually accepted so
        // `drain` never waits on an item that will never be processed.
        Effect.tap((accepted) =>
          accepted ? TxRef.update(outstanding, (n) => n + 1) : Effect.void,
        ),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

/**
 * Create lazily allocated drainable workers keyed by `K`.
 *
 * Workers are retained for the lifetime of the enclosing scope. Thread IDs
 * are the intended key here and are bounded by the server's thread set; this
 * keeps enqueueing simple while preserving per-key ordering. The shared
 * outstanding count makes `drain` cover all lazily created workers, including
 * items enqueued while another key is still processing.
 */
export const makeKeyedDrainableWorker = <K, A, E, R>(
  process: (key: K, item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<KeyedDrainableWorker<K, A, R>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const workerScope = yield* Scope.Scope;
    const workers = new Map<K, DrainableWorker<A>>();
    const workersLock = yield* Semaphore.make(1);
    const outstanding = yield* TxRef.make(0);

    const getWorker = (key: K) =>
      workersLock.withPermit(
        Effect.gen(function* () {
          const existing = workers.get(key);
          if (existing !== undefined) {
            return existing;
          }

          const worker = yield* makeDrainableWorker((item: A) =>
            Effect.ensuring(
              process(key, item),
              TxRef.update(outstanding, (n) => n - 1),
            ),
          ).pipe(Effect.provideService(Scope.Scope, workerScope));
          workers.set(key, worker);
          return worker;
        }),
      );

    const enqueue: KeyedDrainableWorker<K, A, R>["enqueue"] = (key, item) =>
      Effect.gen(function* () {
        const worker = yield* getWorker(key);
        // Reserve the item before offering it to the per-key queue so a
        // concurrent drain cannot observe a false idle state.
        yield* TxRef.update(outstanding, (n) => n + 1).pipe(Effect.tx);
        const accepted = yield* worker
          .enqueue(item)
          .pipe(Effect.onError(() => TxRef.update(outstanding, (n) => n - 1).pipe(Effect.tx)));
        if (!accepted) {
          // The per-key queue rejected the offer (it resolves `false` on a
          // shut-down queue rather than failing), so release the reservation
          // or `drain` would wait forever on an item that was never queued.
          yield* TxRef.update(outstanding, (n) => n - 1).pipe(Effect.tx);
        }
      });

    const drain: KeyedDrainableWorker<K, A, R>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    return { enqueue, drain } satisfies KeyedDrainableWorker<K, A, R>;
  });
