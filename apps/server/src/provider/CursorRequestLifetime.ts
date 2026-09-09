import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

export class CursorRequestLifetime extends Context.Service<
  CursorRequestLifetime,
  {
    readonly fork: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<Fiber.Fiber<A, E>>;
  }
>()("t3/provider/CursorRequestLifetime") {}

export const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  return {
    fork: <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.forkIn(scope, { startImmediately: true })),
  };
});

/** Application-owned requests can settle and clean up after an instance closes. */
export const layer = Layer.effect(CursorRequestLifetime, make);
