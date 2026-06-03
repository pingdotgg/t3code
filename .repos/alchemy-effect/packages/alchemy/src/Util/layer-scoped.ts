import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

/**
 * Builds a layer with the current scope.
 * @param layer - The layer to build.
 * @returns A scoped effect returning a Context with the provided layer.
 */
export const buildLayerScoped = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
): Effect.Effect<Context.Context<ROut>, E, RIn | Scope.Scope> =>
  Effect.flatMap(Effect.scope, (scope) => Layer.buildWithScope(layer, scope));

/**
 * Builds a layer with the current scope and provides it to the given effect.
 * @param layer - The layer to build.
 */
export const provideLayerScoped =
  <ROut, E1, RIn>(layer: Layer.Layer<ROut, E1, RIn>) =>
  <A, E2, R>(effect: Effect.Effect<A, E2, R>) =>
    Effect.flatMap(buildLayerScoped(layer), (context) =>
      Effect.provideContext(effect, context),
    );
