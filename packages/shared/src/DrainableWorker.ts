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
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
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
 * Create drainable FIFO lanes keyed by an item field.
 *
 * Lane lookup, creation, and idle cleanup all serialize on a semaphore, so
 * concurrent enqueues for a not-yet-seen key atomically reserve a single
 * lane. A plain check-then-create on the lane map would let two fibers both
 * observe a missing key and each create a lane, splitting the key's FIFO
 * across lanes.
 *
 * Each key gets its own FIFO lane while different keys process concurrently.
 * `drain` is quiescent: it loops snapshot+drain until no lane holds
 * unprocessed work offered during the drain (new keys, recreated lanes, or
 * version-bumped lanes). Idle lanes are
 * removed once drained so key cardinality stays bounded.
 *
 * @param keyOf - Derives the lane key for an item.
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `enqueue` and `drain`.
 */
export const makeKeyedDrainableWorker = <A, K, E, R>(
  keyOf: (item: A) => K,
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const scope = yield* Scope.Scope;
    const laneLock = yield* Semaphore.make(1);
    type Entry = {
      readonly worker: DrainableWorker<A>;
      readonly scope: Scope.Closeable;
      version: number;
    };
    const entries = new Map<K, Entry>();
    const processInParentScope = (item: A) =>
      process(item).pipe(Effect.provide(context), Scope.provide(scope));

    const removeWhenIdle = (key: K, entry: Entry): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const observedVersion = yield* laneLock.withPermit(
            Effect.sync(() => (entries.get(key) === entry ? entry.version : undefined)),
          );
          if (observedVersion === undefined) {
            return;
          }
          yield* entry.worker.drain;
          const removed = yield* laneLock.withPermit(
            Effect.sync(() => {
              if (entries.get(key) !== entry || entry.version !== observedVersion) {
                return false;
              }
              entries.delete(key);
              return true;
            }),
          );
          if (removed) {
            yield* Scope.close(entry.scope, Exit.void);
            return;
          }
        }
      });

    const enqueue = (item: A): Effect.Effect<void> =>
      laneLock.withPermit(
        Effect.gen(function* () {
          const key = keyOf(item);
          const existing = entries.get(key);
          if (existing !== undefined) {
            existing.version += 1;
            yield* existing.worker.enqueue(item);
            return;
          }
          const laneScope = yield* Scope.fork(scope, "sequential");
          const worker = yield* makeDrainableWorker(processInParentScope).pipe(
            Scope.provide(laneScope),
          );
          const entry: Entry = { worker, scope: laneScope, version: 1 };
          entries.set(key, entry);
          yield* worker.enqueue(item);
          yield* removeWhenIdle(key, entry).pipe(Effect.forkIn(scope));
        }),
      );

    const drain: DrainableWorker<A>["drain"] = Effect.gen(function* () {
      while (true) {
        const snapshot = yield* laneLock.withPermit(
          Effect.sync(() =>
            Array.from(entries.entries()).map(([key, entry]) => ({
              key,
              entry,
              version: entry.version,
            })),
          ),
        );
        if (snapshot.length === 0) {
          return;
        }
        yield* Effect.forEach(snapshot, ({ entry }) => entry.worker.drain, {
          concurrency: "unbounded",
          discard: true,
        });
        const settled = yield* laneLock.withPermit(
          Effect.sync(() => {
            const seen = new Map<K, { readonly entry: Entry; readonly version: number }>();
            for (const { key, entry, version } of snapshot) {
              seen.set(key, { entry, version });
            }
            for (const [key, current] of entries) {
              const prior = seen.get(key);
              if (prior === undefined) {
                return false;
              }
              if (current !== prior.entry || current.version !== prior.version) {
                return false;
              }
            }
            return true;
          }),
        );
        if (settled) {
          return;
        }
      }
    });

    return { enqueue, drain } satisfies DrainableWorker<A>;
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
