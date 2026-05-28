import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface TailscaleServeRuntimeShape {
  readonly awaitConfigured: Effect.Effect<boolean>;
  readonly markConfigured: Effect.Effect<void>;
  readonly markUnavailable: Effect.Effect<void>;
}

export class TailscaleServeRuntime extends Context.Service<
  TailscaleServeRuntime,
  TailscaleServeRuntimeShape
>()("t3/tailscaleServeRuntime") {}

export const TailscaleServeRuntimeLive = Layer.effect(
  TailscaleServeRuntime,
  Effect.gen(function* () {
    const configured = yield* Deferred.make<boolean>();
    const complete = (value: boolean) => Deferred.succeed(configured, value).pipe(Effect.ignore);

    return {
      awaitConfigured: Deferred.await(configured),
      markConfigured: complete(true),
      markUnavailable: complete(false),
    } satisfies TailscaleServeRuntimeShape;
  }),
);
