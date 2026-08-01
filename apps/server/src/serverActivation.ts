import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** Forks a long-running root before commit and proves it is parked at the activation boundary. */
export const forkParked = <A, E, R>(
  activation: Effect.Effect<void> | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> =>
  activation === undefined
    ? Effect.forkScoped(effect).pipe(Effect.asVoid)
    : Effect.gen(function* () {
        const parked = yield* Deferred.make<void>();
        yield* Effect.forkScoped(
          Deferred.succeed(parked, undefined).pipe(
            Effect.andThen(activation),
            Effect.andThen(effect),
          ),
        );
        yield* Deferred.await(parked);
      });
