import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

export const forkParkedFiber = Effect.fn("serverActivation.forkParkedFiber")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<Fiber.Fiber<A, E>, never, Scope.Scope | R> {
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

interface BackgroundStart {
  readonly awaitTurn: Effect.Effect<void>;
  readonly markClientServed: Effect.Effect<void>;
}

export class ServerBackgroundStart extends Context.Reference<BackgroundStart | undefined>(
  "t3/serverBackgroundStart",
  { defaultValue: () => undefined },
) {}

export const makeBackgroundStart = Effect.fn("serverActivation.makeBackgroundStart")(function* (
  activation: Effect.Effect<void>,
) {
  const clientServed = yield* Deferred.make<void>();
  // Headless environments still run maintenance even if no client connects.
  const ready = yield* activation.pipe(
    Effect.andThen(Deferred.await(clientServed).pipe(Effect.timeoutOption("30 seconds"))),
    Effect.forkScoped,
  );
  return {
    awaitTurn: Fiber.join(ready).pipe(Effect.asVoid),
    markClientServed: Deferred.succeed(clientServed, undefined).pipe(Effect.asVoid),
  } satisfies BackgroundStart;
});

export const awaitBackgroundTurn = Effect.gen(function* () {
  const background = yield* ServerBackgroundStart;
  if (background !== undefined) yield* background.awaitTurn;
});

export const markClientServed = Effect.gen(function* () {
  const background = yield* ServerBackgroundStart;
  if (background !== undefined) yield* background.markClientServed;
});

export const forkBackground = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  forkParked(Effect.andThen(awaitBackgroundTurn, effect));
