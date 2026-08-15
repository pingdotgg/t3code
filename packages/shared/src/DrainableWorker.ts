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

/** Create drainable FIFO lanes keyed by an item field. */
export const makeKeyedDrainableWorker = <A, K, E, R>(
  keyOf: (item: A) => K,
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const scope = yield* Scope.Scope;
    type Entry = { readonly worker: DrainableWorker<A>; version: number };
    const entries = new Map<K, Entry>();

    const removeWhenIdle = (key: K, entry: Entry) =>
      Effect.gen(function* () {
        while (entries.get(key) === entry) {
          const observedVersion = entry.version;
          yield* entry.worker.drain;
          if (entry.version === observedVersion && entries.get(key) === entry) {
            entries.delete(key);
            return;
          }
        }
      });

    const enqueue = (item: A): Effect.Effect<void> =>
      Effect.gen(function* () {
        const key = keyOf(item);
        const existing = entries.get(key);
        if (existing !== undefined) {
          existing.version += 1;
          yield* existing.worker.enqueue(item);
          return;
        }
        const worker = yield* makeDrainableWorker(process).pipe(
          Effect.provide(context),
          Scope.provide(scope),
        );
        const entry: Entry = { worker, version: 1 };
        entries.set(key, entry);
        yield* worker.enqueue(item);
        yield* removeWhenIdle(key, entry).pipe(Effect.forkIn(scope));
      });

    return {
      enqueue,
      drain: Effect.suspend(() =>
        Effect.forEach(entries.values(), (entry) => entry.worker.drain, {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    } satisfies DrainableWorker<A>;
  });

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
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });
