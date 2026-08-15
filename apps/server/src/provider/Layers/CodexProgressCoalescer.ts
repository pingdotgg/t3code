import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface CodexProgressCoalescer<K, V> {
  readonly offerItem: (key: K, value: V) => Effect.Effect<void>;
  readonly offerTokenUsage: (key: K, value: V) => Effect.Effect<void>;
  readonly flush: (key: K) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

interface Worker {
  readonly token: object;
  readonly fiber: Fiber.Fiber<void, never>;
}

interface KeyState<V> {
  readonly lock: Semaphore.Semaphore;
  item: Option.Option<V>;
  tokenUsage: Option.Option<V>;
  worker: Worker | null;
}

interface RegistryState<K, V> {
  readonly closed: boolean;
  readonly keys: Map<K, KeyState<V>>;
}

export const makeCodexProgressCoalescer = Effect.fn("makeCodexProgressCoalescer")(function* <
  K,
  V,
>(options: {
  readonly window?: Duration.Input;
  readonly emit: (values: ReadonlyArray<V>) => Effect.Effect<void>;
}): Effect.fn.Return<CodexProgressCoalescer<K, V>, never, Scope.Scope> {
  const window = options.window ?? Duration.millis(250);
  const workerScope = yield* Scope.make("parallel");
  const closeDone = yield* Deferred.make<void>();
  const registryRef = yield* SynchronizedRef.make<RegistryState<K, V>>({
    closed: false,
    keys: new Map(),
  });

  const takeValues = (state: KeyState<V>): ReadonlyArray<V> => {
    const values: Array<V> = [];
    if (Option.isSome(state.item)) {
      values.push(state.item.value);
    }
    if (Option.isSome(state.tokenUsage)) {
      values.push(state.tokenUsage.value);
    }
    state.item = Option.none();
    state.tokenUsage = Option.none();
    return values;
  };

  const clearWorker = (state: KeyState<V>, token: object) =>
    state.lock.withPermit(
      Effect.sync(() => {
        if (state.worker?.token === token) {
          state.worker = null;
        }
      }),
    );

  const tick = (state: KeyState<V>, token: object) =>
    state.lock.withPermit(
      Effect.gen(function* () {
        if (state.worker?.token !== token) {
          return;
        }
        if ((yield* SynchronizedRef.get(registryRef)).closed) {
          takeValues(state);
          return;
        }

        const values = takeValues(state);
        if (values.length > 0) {
          yield* options.emit(values);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (state.worker?.token === token) {
              state.worker = null;
            }
          }),
        ),
      ),
    );

  const startWorker = Effect.fn("CodexProgressCoalescer.startWorker")(function* (
    state: KeyState<V>,
  ) {
    const token = {};
    const fiber = yield* Effect.sleep(window).pipe(
      Effect.andThen(tick(state, token)),
      Effect.ensuring(clearWorker(state, token)),
      Effect.forkIn(workerScope, { startImmediately: true }),
    );
    state.worker = { token, fiber };
  });

  const getOrCreateKeyState = (key: K): Effect.Effect<KeyState<V> | null> =>
    SynchronizedRef.modifyEffect(registryRef, (registry) => {
      if (registry.closed) {
        return Effect.succeed([null, registry] as const);
      }
      const existing = registry.keys.get(key);
      if (existing !== undefined) {
        return Effect.succeed([existing, registry] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((lock) => {
          const state: KeyState<V> = {
            lock,
            item: Option.none(),
            tokenUsage: Option.none(),
            worker: null,
          };
          const keys = new Map(registry.keys);
          keys.set(key, state);
          return [state, { closed: false, keys }] as const;
        }),
      );
    });

  const getExistingKeyState = (key: K): Effect.Effect<KeyState<V> | null> =>
    SynchronizedRef.get(registryRef).pipe(
      Effect.map((registry) => (registry.closed ? null : (registry.keys.get(key) ?? null))),
    );

  const offer =
    (lane: "item" | "tokenUsage") =>
    (key: K, value: V): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = yield* getOrCreateKeyState(key);
        if (state === null) {
          return;
        }
        yield* state.lock.withPermit(
          Effect.gen(function* () {
            if ((yield* SynchronizedRef.get(registryRef)).closed) {
              return;
            }
            state[lane] = Option.some(value);
            if (state.worker === null) {
              yield* startWorker(state);
            }
          }),
        );
      });

  const flush = Effect.fn("CodexProgressCoalescer.flush")(function* (key: K) {
    const state = yield* getExistingKeyState(key);
    if (state === null) {
      return;
    }

    let workerToInterrupt: Fiber.Fiber<void, never> | null = null;
    yield* state.lock
      .withPermit(
        Effect.gen(function* () {
          if ((yield* SynchronizedRef.get(registryRef)).closed) {
            return;
          }
          workerToInterrupt = state.worker?.fiber ?? null;
          state.worker = null;
          const values = takeValues(state);
          if (values.length > 0) {
            yield* options.emit(values);
          }
        }),
      )
      .pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            workerToInterrupt === null ? Effect.void : Fiber.interrupt(workerToInterrupt),
          ),
        ),
      );
  });

  const close = Effect.uninterruptible(
    Effect.gen(function* () {
      const states = yield* SynchronizedRef.modify(registryRef, (registry) =>
        registry.closed
          ? ([null, registry] as const)
          : ([Array.from(registry.keys.values()), { ...registry, closed: true }] as const),
      );
      if (states === null) {
        yield* Deferred.await(closeDone);
        return;
      }

      yield* Scope.close(workerScope, Exit.void);
      const lateWorkers = yield* Effect.forEach(
        states,
        (state) =>
          state.lock.withPermit(
            Effect.sync(() => {
              const worker = state.worker?.fiber ?? null;
              state.worker = null;
              takeValues(state);
              return worker;
            }),
          ),
        { concurrency: "unbounded" },
      );
      yield* Fiber.interruptAll(lateWorkers.filter((fiber) => fiber !== null));
      yield* SynchronizedRef.update(registryRef, (registry) => ({
        ...registry,
        keys: new Map(),
      }));
      yield* Deferred.succeed(closeDone, undefined);
    }),
  );

  yield* Effect.addFinalizer(() => close);
  return {
    offerItem: offer("item"),
    offerTokenUsage: offer("tokenUsage"),
    flush,
    close,
  };
});
