import type { PluginId, PluginManifest } from "@t3tools/contracts/plugin";
import type { PluginRegistration } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface ActivePluginRuntime {
  readonly manifest: PluginManifest;
  readonly registration: PluginRegistration;
  readonly readiness: Deferred.Deferred<void>;
  readonly scope: Scope.Scope;
}

export type PluginRuntimeChange =
  | {
      readonly _tag: "put";
      readonly pluginId: PluginId;
      readonly runtime: ActivePluginRuntime;
    }
  | {
      readonly _tag: "remove";
      readonly pluginId: PluginId;
    };

export class PluginRuntimeRegistry extends Context.Service<
  PluginRuntimeRegistry,
  {
    readonly put: (pluginId: PluginId, runtime: ActivePluginRuntime) => Effect.Effect<void>;
    readonly remove: (pluginId: PluginId) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<ActivePluginRuntime>>;
    readonly get: (pluginId: PluginId) => Effect.Effect<Option.Option<ActivePluginRuntime>>;
    /** Process-lifetime stream of put/remove events for MCP toolkit subscription. */
    readonly changes: Stream.Stream<PluginRuntimeChange>;
  }
>()("t3/plugins/PluginRuntimeRegistry") {}

export const make = Effect.fn("PluginRuntimeRegistry.make")(function* () {
  const runtimes = yield* Ref.make(new Map<PluginId, ActivePluginRuntime>());
  const changesPubSub = yield* PubSub.unbounded<PluginRuntimeChange>();

  return PluginRuntimeRegistry.of({
    put: (pluginId, runtime) =>
      Ref.update(runtimes, (current) => {
        const next = new Map(current);
        next.set(pluginId, runtime);
        return next;
      }).pipe(
        Effect.andThen(
          PubSub.publish(changesPubSub, { _tag: "put", pluginId, runtime }).pipe(Effect.asVoid),
        ),
      ),
    remove: (pluginId) =>
      Ref.update(runtimes, (current) => {
        const next = new Map(current);
        next.delete(pluginId);
        return next;
      }).pipe(
        Effect.andThen(
          PubSub.publish(changesPubSub, { _tag: "remove", pluginId }).pipe(Effect.asVoid),
        ),
      ),
    list: Ref.get(runtimes).pipe(Effect.map((current) => Array.from(current.values()))),
    get: (pluginId) =>
      Ref.get(runtimes).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(pluginId))),
      ),
    changes: Stream.fromPubSub(changesPubSub),
  });
});

export const layer = Layer.effect(PluginRuntimeRegistry, make());
