import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

export const forkParkedFiber = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Fiber.Fiber<A, E>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      return yield* Effect.forkScoped(effect);
    }
    const parked = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkScoped(
      Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
    );
    yield* Deferred.await(parked);
    return fiber;
  });

export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> => forkParkedFiber(effect).pipe(Effect.asVoid);

export interface BackgroundStart {
  readonly awaitFirstClient: Effect.Effect<void>;
  readonly awaitTurn: Effect.Effect<void>;
  readonly markClientServed: Effect.Effect<void>;
}

export class ServerBackgroundStart extends Context.Reference<BackgroundStart | undefined>(
  "t3/serverBackgroundStart",
  { defaultValue: () => undefined },
) {}

// Probes wait for config delivery (at most 10s). Maintenance also waits for a
// quiet startup (10s, at most 30s).
export const makeBackgroundStart = (activation: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const clientServed = yield* Deferred.make<void>();
    const served = Deferred.await(clientServed);
    const firstClient = yield* activation.pipe(
      Effect.andThen(served.pipe(Effect.timeoutOption("10 seconds"))),
      Effect.forkScoped,
    );
    const quiet = yield* activation.pipe(
      Effect.andThen(
        Effect.all([Effect.sleep("10 seconds"), served], { concurrency: "unbounded" }).pipe(
          Effect.timeoutOption("30 seconds"),
        ),
      ),
      Effect.forkScoped,
    );
    return {
      awaitFirstClient: Fiber.join(firstClient).pipe(Effect.asVoid),
      awaitTurn: Fiber.join(quiet).pipe(Effect.asVoid),
      markClientServed: Deferred.succeed(clientServed, undefined).pipe(Effect.asVoid),
    } satisfies BackgroundStart;
  });

export const awaitBackgroundTurn = Effect.gen(function* () {
  const gate = yield* ServerBackgroundStart;
  if (gate !== undefined) yield* gate.awaitTurn;
});

export const markClientServed = Effect.gen(function* () {
  const gate = yield* ServerBackgroundStart;
  if (gate !== undefined) yield* gate.markClientServed;
});

export const forkBackground = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  forkParked(Effect.andThen(awaitBackgroundTurn, effect));
