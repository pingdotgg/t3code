import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

/**
 * Forks a long-running root before commit, returning it after it reaches the activation boundary.
 * `detached` leaves the fiber unbound from the scope — the caller owns its shutdown —
 * for workers whose scope-finalizer interrupt wait must stay bounded.
 */
export const forkParkedFiber = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { readonly detached?: boolean },
): Effect.Effect<Fiber.Fiber<A, E>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const activation = yield* ServerActivation;
    const fork = options?.detached === true ? Effect.forkDetach : Effect.forkScoped;
    if (activation === undefined) {
      return yield* fork(effect);
    }
    const parked = yield* Deferred.make<void>();
    const fiber = yield* fork(
      Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
    );
    yield* Deferred.await(parked);
    return fiber;
  });

/** Forks a long-running root before commit and proves it is parked at the activation boundary. */
export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> => forkParkedFiber(effect).pipe(Effect.asVoid);
