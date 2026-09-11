import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface ReplayRecorderDeferredRegistry {
  readonly getOrCreate: (key: string) => Effect.Effect<Deferred.Deferred<void>>;
  readonly succeed: (key: string) => Effect.Effect<void>;
}

export const makeReplayRecorderDeferredRegistry = Effect.fn("makeReplayRecorderDeferredRegistry")(
  function* () {
    const state = yield* SynchronizedRef.make(new Map<string, Deferred.Deferred<void>>());

    const getOrCreate = Effect.fn("ReplayRecorderDeferredRegistry.getOrCreate")(function* (
      key: string,
    ) {
      return yield* SynchronizedRef.modifyEffect(state, (deferreds) => {
        const existing = deferreds.get(key);
        if (existing !== undefined) {
          return Effect.succeed([existing, deferreds] as const);
        }

        return Deferred.make<void>().pipe(
          Effect.map((deferred) => {
            const next = new Map(deferreds);
            next.set(key, deferred);
            return [deferred, next] as const;
          }),
        );
      });
    });

    const succeed = Effect.fn("ReplayRecorderDeferredRegistry.succeed")(function* (key: string) {
      const deferred = yield* getOrCreate(key);
      yield* Deferred.succeed(deferred, undefined);
    });

    return {
      getOrCreate,
      succeed,
    } satisfies ReplayRecorderDeferredRegistry;
  },
);
