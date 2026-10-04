/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common queue + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import type { Scope } from "effect";
import { Deferred, Effect, TxQueue, TxRef } from "effect";

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

export interface DrainableWorkerOptions {
  /**
   * Maximum number of work items waiting to be processed.
   *
   * Enqueueing waits for capacity instead of allowing the queue to grow
   * without bound.
   */
  readonly capacity: number;

  /**
   * Maximum number of work items processed at the same time.
   *
   * Defaults to one.
   */
  readonly concurrency?: number;
}

/**
 * Create a drainable worker that processes items from a queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @param options - Optional bounded-queue configuration.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options?: DrainableWorkerOptions,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(
      options === undefined ? TxQueue.unbounded<A>() : TxQueue.bounded<A>(options.capacity),
      TxQueue.shutdown,
    );
    const outstanding = yield* TxRef.make(0);

    const concurrency = Math.max(1, Math.floor(options?.concurrency ?? 1));
    yield* Effect.forEach(
      Array.from({ length: concurrency }),
      () =>
        TxQueue.take(queue).pipe(
          Effect.tap((a) =>
            Effect.ensuring(
              process(a),
              TxRef.update(outstanding, (n) => n - 1),
            ),
          ),
          Effect.forever,
          Effect.forkScoped,
        ),
      { discard: true },
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

/**
 * Create a drainable worker that runs items in enqueue order per key while
 * items for different keys run concurrently. An item naming several keys waits
 * for the earlier work of every key it names, and later work on any of those
 * keys waits for it. A failed or defective item never wedges its keys.
 *
 * Enqueue order must be deterministic (a single producer fiber) for per-key
 * ordering to be meaningful.
 */
export const makeKeyedDrainableWorker = <A, K, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  keysOf: (item: A) => ReadonlyArray<K>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const tails = new Map<K, Deferred.Deferred<void>>();
    const outstanding = yield* TxRef.make(0);

    const enqueue = (item: A): Effect.Effect<void> =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        const keys = [...new Set(keysOf(item))];
        const previous = keys.flatMap((key) => {
          const tail = tails.get(key);
          tails.set(key, done);
          return tail === undefined ? [] : [tail];
        });
        yield* TxRef.update(outstanding, (n) => n + 1).pipe(Effect.tx);
        yield* Effect.forEach(previous, Deferred.await, { discard: true }).pipe(
          Effect.andThen(Effect.exit(Effect.provideContext(process(item), context))),
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of keys) {
                if (tails.get(key) === done) tails.delete(key);
              }
            }).pipe(
              Effect.andThen(Deferred.succeed(done, undefined)),
              Effect.andThen(TxRef.update(outstanding, (n) => n - 1).pipe(Effect.tx)),
            ),
          ),
          Effect.forkIn(scope),
        );
      });

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
