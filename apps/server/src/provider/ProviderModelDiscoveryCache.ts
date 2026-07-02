import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

export interface ProviderModelDiscoveryCache {
  readonly getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>, never, never>;
  readonly setRefresh: (
    refresh: Effect.Effect<unknown, never, never>,
  ) => Effect.Effect<void, never, never>;
  readonly recordModels: (
    models: ReadonlyArray<ServerProviderModel>,
  ) => Effect.Effect<void, never, never>;
}

export function makeProviderModelDiscoveryCache(): Effect.Effect<
  ProviderModelDiscoveryCache,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const modelsRef = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
    const refreshRef = yield* Ref.make<Effect.Effect<unknown, never, never>>(Effect.void);

    const scheduleRefresh: Effect.Effect<void, never, never> = Effect.gen(function* () {
      const refresh = yield* Ref.get(refreshRef);
      yield* refresh.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope), Effect.asVoid);
    });

    return {
      getModels: Ref.get(modelsRef),
      setRefresh: (refresh) => Ref.set(refreshRef, refresh),
      recordModels: (models) =>
        Ref.set(modelsRef, models).pipe(Effect.andThen(scheduleRefresh), Effect.asVoid),
    } satisfies ProviderModelDiscoveryCache;
  });
}
