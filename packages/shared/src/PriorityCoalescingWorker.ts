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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface PriorityCoalescingWorker<K extends string, V> {
  readonly enqueueRealtime: (value: V) => Effect.Effect<void>;
  readonly enqueueBackground: (key: K, value: V) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

interface BackgroundState<K extends string, V> {
  readonly latestByKey: HashMap.HashMap<K, V>;
  readonly queuedKeys: HashSet.HashSet<K>;
  readonly activeKeys: HashSet.HashSet<K>;
}

type WorkItem<K extends string, V> =
  | { readonly _tag: "Realtime"; readonly value: V }
  | { readonly _tag: "Background"; readonly key: K; readonly value: V };

export const makePriorityCoalescingWorker = <K extends string, V, E, R>(options: {
  readonly mergeBackground: (current: V, next: V) => V;
  readonly process: (value: V) => Effect.Effect<void, E, R>;
}): Effect.Effect<PriorityCoalescingWorker<K, V>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const realtimeQueue = yield* Effect.acquireRelease(TxQueue.unbounded<V>(), TxQueue.shutdown);
    const backgroundQueue = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const backgroundState = yield* TxRef.make<BackgroundState<K, V>>({
      latestByKey: HashMap.empty(),
      queuedKeys: HashSet.empty(),
      activeKeys: HashSet.empty(),
    });
    const outstanding = yield* TxRef.make(0);

    const takeNext = Effect.gen(function* () {
      const realtime = yield* TxQueue.poll(realtimeQueue);
      if (Option.isSome(realtime)) {
        return { _tag: "Realtime", value: realtime.value } as const;
      }

      const key = yield* TxQueue.take(backgroundQueue);
      const state = yield* TxRef.get(backgroundState);
      const value = HashMap.get(state.latestByKey, key);
      if (Option.isNone(value)) {
        return yield* Effect.txRetry;
      }

      yield* TxRef.set(backgroundState, {
        latestByKey: HashMap.remove(state.latestByKey, key),
        queuedKeys: HashSet.remove(state.queuedKeys, key),
        activeKeys: HashSet.add(state.activeKeys, key),
      });

      return { _tag: "Background", key, value: value.value } as const;
    }).pipe(Effect.tx);

    const finishBackground = (key: K) =>
      Effect.gen(function* () {
        const state = yield* TxRef.get(backgroundState);
        const activeKeys = HashSet.remove(state.activeKeys, key);

        if (!HashMap.has(state.latestByKey, key)) {
          yield* TxRef.set(backgroundState, { ...state, activeKeys });
          yield* TxRef.update(outstanding, (count) => count - 1);
          return;
        }

        yield* TxRef.set(backgroundState, {
          ...state,
          queuedKeys: HashSet.add(state.queuedKeys, key),
          activeKeys,
        });
        yield* TxQueue.offer(backgroundQueue, key);
      }).pipe(Effect.tx);

    // One malformed event must not terminate the worker and strand later work.
    // Scoped interruption still propagates so shutdown remains prompt.
    const keepWorkerAlive = <A, E>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.void,
        ),
      );

    yield* takeNext.pipe(
      Effect.flatMap((item: WorkItem<K, V>) =>
        item._tag === "Realtime"
          ? keepWorkerAlive(
              options
                .process(item.value)
                .pipe(
                  Effect.ensuring(TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx)),
                ),
            )
          : keepWorkerAlive(
              options.process(item.value).pipe(Effect.ensuring(finishBackground(item.key))),
            ),
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
        const existing = HashMap.get(state.latestByKey, key);
        const latestByKey = HashMap.set(
          state.latestByKey,
          key,
          Option.match(existing, {
            onNone: () => value,
            onSome: (current) => options.mergeBackground(current, value),
          }),
        );

        if (HashSet.has(state.queuedKeys, key) || HashSet.has(state.activeKeys, key)) {
          yield* TxRef.set(backgroundState, { ...state, latestByKey });
          return;
        }

        yield* TxRef.set(backgroundState, {
          ...state,
          latestByKey,
          queuedKeys: HashSet.add(state.queuedKeys, key),
        });
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
