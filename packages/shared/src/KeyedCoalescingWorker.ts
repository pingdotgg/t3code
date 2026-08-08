/**
 * KeyedCoalescingWorker - A keyed worker that keeps only the latest value per key.
 *
 * Enqueues for an active or already-queued key are merged atomically instead of
 * creating duplicate queued items. `flushKey()` promotes pending work for one
 * key and processes it without waiting behind unrelated keys, while
 * `drainKey()` only waits for work already in flight. An optional cooldown
 * rate-limits the normal background consumer after it releases the active key,
 * so direct flushes remain delay-free.
 *
 * @module KeyedCoalescingWorker
 */
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface KeyedCoalescingWorker<K, V> {
  readonly enqueue: (key: K, value: V) => Effect.Effect<void>;
  readonly flushKey: (key: K) => Effect.Effect<void>;
  readonly drainKey: (key: K) => Effect.Effect<void>;
}

export interface KeyedCoalescingWorkerProcessContext {
  readonly flush: boolean;
}

interface KeyedCoalescingWorkerState<K, V> {
  readonly latestByKey: Map<K, V>;
  readonly queuedKeys: Set<K>;
  readonly activeKeys: Set<K>;
  readonly flushRequestedKeys: Set<K>;
}

type ProcessKeyNext<V> =
  | { readonly _tag: "Process"; readonly value: V }
  | { readonly _tag: "Requeue" }
  | null;

export const makeKeyedCoalescingWorker = <K, V, E, R>(options: {
  readonly cooldown?: Duration.Input;
  readonly merge: (current: V, next: V) => V;
  readonly process: (
    key: K,
    value: V,
    context: KeyedCoalescingWorkerProcessContext,
  ) => Effect.Effect<void, E, R>;
}): Effect.Effect<KeyedCoalescingWorker<K, V>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const processContext = yield* Effect.context<R>();
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const stateRef = yield* TxRef.make<KeyedCoalescingWorkerState<K, V>>({
      latestByKey: new Map(),
      queuedKeys: new Set(),
      activeKeys: new Set(),
      flushRequestedKeys: new Set(),
    });
    const cooldown = options.cooldown === undefined ? Effect.void : Effect.sleep(options.cooldown);

    const processKey = (key: K, value: V, flush: boolean): Effect.Effect<void, E> =>
      options.process(key, value, { flush }).pipe(
        Effect.provide(processContext),
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const next = yield* TxRef.modify(
              stateRef,
              (state): [ProcessKeyNext<V>, KeyedCoalescingWorkerState<K, V>] => {
                const nextValue = state.latestByKey.get(key);
                if (nextValue === undefined) {
                  const activeKeys = new Set(state.activeKeys);
                  activeKeys.delete(key);
                  const flushRequestedKeys = new Set(state.flushRequestedKeys);
                  flushRequestedKeys.delete(key);
                  return [null, { ...state, activeKeys, flushRequestedKeys }];
                }

                if (!state.flushRequestedKeys.has(key)) {
                  const queuedKeys = new Set(state.queuedKeys);
                  queuedKeys.add(key);
                  const activeKeys = new Set(state.activeKeys);
                  activeKeys.delete(key);
                  return [{ _tag: "Requeue" }, { ...state, queuedKeys, activeKeys }];
                }

                const latestByKey = new Map(state.latestByKey);
                latestByKey.delete(key);
                return [
                  { _tag: "Process", value: nextValue },
                  { ...state, latestByKey },
                ];
              },
            );
            if (next?._tag === "Requeue") {
              yield* TxQueue.offer(queue, key);
            }
            return next;
          }).pipe(Effect.tx),
        ),
        Effect.flatMap((next) =>
          next === null
            ? Effect.void
            : next._tag === "Requeue"
              ? Effect.void
              : processKey(key, next.value, true),
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

        const flushRequestedKeys = new Set(state.flushRequestedKeys);
        flushRequestedKeys.delete(key);
        return [false, { ...state, activeKeys, flushRequestedKeys }] as const;
      }).pipe(
        Effect.tx,
        Effect.flatMap((shouldRequeue) =>
          shouldRequeue ? TxQueue.offer(queue, key) : Effect.void,
        ),
      );

    const cleanupProcessFailure = (key: K, cause: Cause.Cause<E>): Effect.Effect<void> =>
      cleanupFailedKey(key).pipe(
        Effect.andThen(Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void),
      );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((key) =>
        TxRef.modify(stateRef, (state) => {
          if (state.activeKeys.has(key)) {
            return [null, state] as const;
          }

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
            { key, value, flush: state.flushRequestedKeys.has(key) } as const,
            { ...state, latestByKey, queuedKeys, activeKeys },
          ] as const;
        }).pipe(Effect.tx),
      ),
      Effect.flatMap((item) =>
        item === null
          ? Effect.void
          : processKey(item.key, item.value, item.flush).pipe(
              Effect.catchCause((cause) => cleanupProcessFailure(item.key, cause)),
              Effect.andThen(cooldown),
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

    const flushKey: KeyedCoalescingWorker<K, V>["flushKey"] = (key) =>
      TxRef.modify(stateRef, (state) => {
        const hasWork =
          state.latestByKey.has(key) || state.queuedKeys.has(key) || state.activeKeys.has(key);
        if (!hasWork) {
          return [null, state] as const;
        }

        const flushRequestedKeys = new Set(state.flushRequestedKeys);
        flushRequestedKeys.add(key);
        const value = state.latestByKey.get(key);
        if (state.activeKeys.has(key) || value === undefined) {
          return [null, { ...state, flushRequestedKeys }] as const;
        }

        const latestByKey = new Map(state.latestByKey);
        latestByKey.delete(key);
        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.delete(key);
        const activeKeys = new Set(state.activeKeys);
        activeKeys.add(key);
        return [
          { value },
          {
            ...state,
            latestByKey,
            queuedKeys,
            activeKeys,
            flushRequestedKeys,
          },
        ] as const;
      }).pipe(
        Effect.tx,
        Effect.flatMap((item) =>
          item === null
            ? Effect.void
            : processKey(key, item.value, true).pipe(
                Effect.catchCause((cause) => cleanupProcessFailure(key, cause)),
              ),
        ),
        Effect.andThen(drainKey(key)),
      );

    return { enqueue, flushKey, drainKey } satisfies KeyedCoalescingWorker<K, V>;
  });
