/**
 * A single-lane worker that always drains realtime work before background
 * work and keeps only the latest queued background value for each key.
 *
 * Realtime work cannot interrupt the item already being processed, but it is
 * selected before any remaining background key. Background keys are requeued
 * after one pass, so one hot key cannot starve the others.
 *
 * @module PriorityCoalescingWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface PriorityCoalescingWorker<K, V> {
  readonly enqueueRealtime: (value: V) => Effect.Effect<void>;
  readonly enqueueBackground: (key: K, value: V) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

interface BackgroundState<K, V> {
  readonly latestByKey: Map<K, V>;
  readonly queuedKeys: Set<K>;
  readonly activeKeys: Set<K>;
}

type WorkItem<K, V> =
  | { readonly _tag: "Realtime"; readonly value: V }
  | { readonly _tag: "Background"; readonly key: K; readonly value: V };

export const makePriorityCoalescingWorker = <K, V, E, R>(options: {
  readonly mergeBackground: (current: V, next: V) => V;
  readonly process: (value: V) => Effect.Effect<void, E, R>;
}): Effect.Effect<PriorityCoalescingWorker<K, V>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const realtimeQueue = yield* Effect.acquireRelease(TxQueue.unbounded<V>(), TxQueue.shutdown);
    const backgroundQueue = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const backgroundState = yield* TxRef.make<BackgroundState<K, V>>({
      latestByKey: new Map(),
      queuedKeys: new Set(),
      activeKeys: new Set(),
    });
    const outstanding = yield* TxRef.make(0);

    const takeNext = Effect.gen(function* () {
      const realtime = yield* TxQueue.poll(realtimeQueue);
      if (Option.isSome(realtime)) {
        return { _tag: "Realtime", value: realtime.value } as const;
      }

      const key = yield* TxQueue.take(backgroundQueue);
      const state = yield* TxRef.get(backgroundState);
      if (!state.latestByKey.has(key)) {
        return yield* Effect.txRetry;
      }
      const value = state.latestByKey.get(key) as V;

      const latestByKey = new Map(state.latestByKey);
      latestByKey.delete(key);
      const queuedKeys = new Set(state.queuedKeys);
      queuedKeys.delete(key);
      const activeKeys = new Set(state.activeKeys);
      activeKeys.add(key);
      yield* TxRef.set(backgroundState, { latestByKey, queuedKeys, activeKeys });

      return { _tag: "Background", key, value } as const;
    }).pipe(Effect.tx);

    const finishBackground = (key: K) =>
      Effect.gen(function* () {
        const state = yield* TxRef.get(backgroundState);
        const activeKeys = new Set(state.activeKeys);
        activeKeys.delete(key);

        if (!state.latestByKey.has(key)) {
          yield* TxRef.set(backgroundState, { ...state, activeKeys });
          yield* TxRef.update(outstanding, (count) => count - 1);
          return;
        }

        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.add(key);
        yield* TxRef.set(backgroundState, { ...state, queuedKeys, activeKeys });
        yield* TxQueue.offer(backgroundQueue, key);
      }).pipe(Effect.tx);

    yield* takeNext.pipe(
      Effect.flatMap((item: WorkItem<K, V>) =>
        item._tag === "Realtime"
          ? options
              .process(item.value)
              .pipe(
                Effect.ensuring(TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx)),
              )
          : options.process(item.value).pipe(Effect.ensuring(finishBackground(item.key))),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueueRealtime: PriorityCoalescingWorker<K, V>["enqueueRealtime"] = (value) =>
      TxQueue.offer(realtimeQueue, value).pipe(
        Effect.tap(() => TxRef.update(outstanding, (count) => count + 1)),
        Effect.tx,
        Effect.asVoid,
      );

    const enqueueBackground: PriorityCoalescingWorker<K, V>["enqueueBackground"] = (key, value) =>
      Effect.gen(function* () {
        const state = yield* TxRef.get(backgroundState);
        const latestByKey = new Map(state.latestByKey);
        const existing = latestByKey.get(key);
        latestByKey.set(
          key,
          existing === undefined ? value : options.mergeBackground(existing, value),
        );

        if (state.queuedKeys.has(key) || state.activeKeys.has(key)) {
          yield* TxRef.set(backgroundState, { ...state, latestByKey });
          return;
        }

        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.add(key);
        yield* TxRef.set(backgroundState, { ...state, latestByKey, queuedKeys });
        yield* TxRef.update(outstanding, (count) => count + 1);
        yield* TxQueue.offer(backgroundQueue, key);
      }).pipe(Effect.tx);

    const drain: PriorityCoalescingWorker<K, V>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    return {
      enqueueRealtime,
      enqueueBackground,
      drain,
    } satisfies PriorityCoalescingWorker<K, V>;
  });
