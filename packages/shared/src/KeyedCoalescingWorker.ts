/**
 * KeyedCoalescingWorker - A keyed worker that keeps only the latest value per key.
 *
 * Enqueues for an active or already-queued key are merged atomically instead of
 * creating duplicate queued items. `drainKey()` resolves only when that key has
 * no queued, pending, or active work left.
 *
 * @module KeyedCoalescingWorker
 */
import type { Scope } from "effect";
import { Effect, TxQueue, TxRef } from "effect";

export interface KeyedCoalescingWorker<K, V> {
  readonly enqueue: (key: K, value: V) => Effect.Effect<void>;
  readonly drainKey: (key: K) => Effect.Effect<void>;
}

interface KeyedCoalescingWorkerState<K, V> {
  readonly latestByKey: Map<K, V>;
  readonly queuedKeys: Set<K>;
  readonly activeKeys: Set<K>;
}

export const makeKeyedCoalescingWorker = <K, V, E, R>(options: {
  readonly merge: (current: V, next: V) => V;
  readonly process: (key: K, value: V) => Effect.Effect<void, E, R>;
}): Effect.Effect<KeyedCoalescingWorker<K, V>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const stateRef = yield* TxRef.make<KeyedCoalescingWorkerState<K, V>>({
      latestByKey: new Map(),
      queuedKeys: new Set(),
      activeKeys: new Set(),
    });

    const processKey = (key: K, value: V): Effect.Effect<void, E, R> =>
      options.process(key, value).pipe(
        Effect.flatMap(() =>
          TxRef.modify(stateRef, (state) => {
            const nextValue = state.latestByKey.get(key);
            if (nextValue === undefined) {
              const activeKeys = new Set(state.activeKeys);
              activeKeys.delete(key);
              return [null, { ...state, activeKeys }] as const;
            }

            const latestByKey = new Map(state.latestByKey);
            latestByKey.delete(key);
            return [nextValue, { ...state, latestByKey }] as const;
          }).pipe(Effect.tx),
        ),
        Effect.flatMap((nextValue) =>
          nextValue === null ? Effect.void : processKey(key, nextValue),
        ),
      );

    const cleanupFailedKey = (key: K): Effect.Effect<void> =>
      TxRef.modify(stateRef, (state) => {
        const activeKeys = new Set(state.activeKeys);
        activeKeys.delete(key);

        if (state.latestByKey.has(key) && !state.queuedKeys.has(key)) {
          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.add(key);
          return [true, { ...state, activeKeys, queuedKeys }] as const;
        }

        return [false, { ...state, activeKeys }] as const;
      }).pipe(
        Effect.tx,
        Effect.flatMap((shouldRequeue) =>
          shouldRequeue ? TxQueue.offer(queue, key) : Effect.void,
        ),
      );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((key) =>
        TxRef.modify(stateRef, (state) => {
          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.delete(key);

          const value = state.latestByKey.get(key);
          if (value === undefined) {
            return [null, { ...state, queuedKeys }] as const;
          }

          const latestByKey = new Map(state.latestByKey);
          latestByKey.delete(key);
          const activeKeys = new Set(state.activeKeys);
          activeKeys.add(key);

          return [
            { key, value } as const,
            { ...state, latestByKey, queuedKeys, activeKeys },
          ] as const;
        }).pipe(Effect.tx),
      ),
      Effect.flatMap((item) =>
        item === null
          ? Effect.void
          : processKey(item.key, item.value).pipe(
              Effect.catchCause(() => cleanupFailedKey(item.key)),
            ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueue: KeyedCoalescingWorker<K, V>["enqueue"] = (key, value) =>
      TxRef.modify(stateRef, (state) => {
        const latestByKey = new Map(state.latestByKey);
        const existing = latestByKey.get(key);
        latestByKey.set(key, existing === undefined ? value : options.merge(existing, value));

        if (state.queuedKeys.has(key) || state.activeKeys.has(key)) {
          return [false, { ...state, latestByKey }] as const;
        }

        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.add(key);
        return [true, { ...state, latestByKey, queuedKeys }] as const;
      }).pipe(
        Effect.flatMap((shouldOffer) => (shouldOffer ? TxQueue.offer(queue, key) : Effect.void)),
        Effect.tx,
        Effect.asVoid,
      );

    const drainKey: KeyedCoalescingWorker<K, V>["drainKey"] = (key) =>
      TxRef.get(stateRef).pipe(
        Effect.tap((state) =>
          state.latestByKey.has(key) || state.queuedKeys.has(key) || state.activeKeys.has(key)
            ? Effect.txRetry
            : Effect.void,
        ),
        Effect.asVoid,
        Effect.tx,
      );

    return { enqueue, drainKey } satisfies KeyedCoalescingWorker<K, V>;
  });
