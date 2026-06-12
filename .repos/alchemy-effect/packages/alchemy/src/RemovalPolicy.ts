import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class RemovalPolicy extends Context.Service<
  RemovalPolicy,
  "retain" | "destroy"
>()("RemovalPolicy") {}

export const retain: {
  (
    enabled?: boolean,
  ): <R, Req = never>(
    enabled: Effect.Effect<R, never, Req>,
  ) => Effect.Effect<R, never, Req>;
  <Req = never>(
    enabled: Effect.Effect<boolean, never, Req>,
  ): <R, Req2 = never>(
    a: Effect.Effect<R, never, Req2>,
  ) => Effect.Effect<R, never, Req | Req2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any> = true) =>
  (eff: Effect.Effect<any, never, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(RemovalPolicy, enabled ? "retain" : "destroy")
        : Effect.provideServiceEffect(
            RemovalPolicy,
            enabled.pipe(Effect.map((a) => (a ? "retain" : "destroy"))),
          ),
    )) as any;

export const destroy: {
  (
    enabled?: boolean,
  ): <R, Req = never>(
    enabled: Effect.Effect<R, never, Req>,
  ) => Effect.Effect<R, never, Req>;
  <Req = never>(
    enabled: Effect.Effect<boolean, never, Req>,
  ): <R, Req2 = never>(
    a: Effect.Effect<R, never, Req2>,
  ) => Effect.Effect<R, never, Req | Req2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any> = true) =>
  (eff: Effect.Effect<any, never, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(RemovalPolicy, enabled ? "destroy" : "retain")
        : Effect.provideServiceEffect(
            RemovalPolicy,
            enabled.pipe(Effect.map((a) => (a ? "destroy" : "retain"))),
          ),
    )) as any;
