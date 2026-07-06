import type { PluginId, PluginManifest } from "@t3tools/contracts/plugin";
import type { PluginRegistration } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

export interface ActivePluginRuntime {
  readonly manifest: PluginManifest;
  readonly registration: PluginRegistration;
  readonly readiness: Deferred.Deferred<void>;
  readonly scope: Scope.Scope;
}

export class PluginRuntimeRegistry extends Context.Service<
  PluginRuntimeRegistry,
  {
    readonly put: (pluginId: PluginId, runtime: ActivePluginRuntime) => Effect.Effect<void>;
    readonly remove: (pluginId: PluginId) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<ActivePluginRuntime>>;
    readonly get: (pluginId: PluginId) => Effect.Effect<Option.Option<ActivePluginRuntime>>;
  }
>()("t3/plugins/PluginRuntimeRegistry") {}

export const make = Effect.fn("PluginRuntimeRegistry.make")(function* () {
  const runtimes = yield* Ref.make(new Map<PluginId, ActivePluginRuntime>());

  return PluginRuntimeRegistry.of({
    put: (pluginId, runtime) =>
      Ref.update(runtimes, (current) => {
        const next = new Map(current);
        next.set(pluginId, runtime);
        return next;
      }),
    remove: (pluginId) =>
      Ref.update(runtimes, (current) => {
        const next = new Map(current);
        next.delete(pluginId);
        return next;
      }),
    list: Ref.get(runtimes).pipe(Effect.map((current) => Array.from(current.values()))),
    get: (pluginId) =>
      Ref.get(runtimes).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(pluginId))),
      ),
  });
});

export const layer = Layer.effect(PluginRuntimeRegistry, make());
