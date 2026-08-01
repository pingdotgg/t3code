import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ServerShutdown extends Context.Service<
  ServerShutdown,
  {
    readonly request: (exitCode: number) => Effect.Effect<void>;
    readonly awaitRequest: Effect.Effect<number>;
  }
>()("t3/serverShutdown") {}

export const make = Effect.gen(function* () {
  const requested = yield* Deferred.make<number>();
  return ServerShutdown.of({
    request: (exitCode) => Deferred.succeed(requested, exitCode).pipe(Effect.asVoid),
    awaitRequest: Deferred.await(requested),
  });
});

export const layer = Layer.effect(ServerShutdown, make);
