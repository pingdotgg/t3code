import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

/**
 * Drop any ambient `Tracer.ParentSpan` before running long-lived roots.
 *
 * Startup phases (and other short-lived `Effect.withSpan` scopes) often call
 * `forkParked` while a parent span is still current. Forked fibers inherit
 * that `ParentSpan` for their entire lifetime, so every nested span
 * (`ServerSecretStore.get`, RPC handlers, …) keeps parenting under an
 * immortal startup span and pins the `LocalFileSpan` object graph — steady
 * private-memory growth while "idle".
 */
export const withoutAmbientParentSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.updateContext(
    effect,
    (context) => Context.omit(Tracer.ParentSpan)(context) as Context.Context<NoInfer<R>>,
  );

/** Forks a long-running root before commit and proves it is parked at the activation boundary. */
export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const activation = yield* ServerActivation;
    const detached = withoutAmbientParentSpan(effect);
    if (activation === undefined) {
      yield* Effect.forkScoped(detached);
      return;
    }
    const parked = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      Deferred.succeed(parked, undefined).pipe(
        Effect.andThen(activation),
        Effect.andThen(detached),
      ),
    );
    yield* Deferred.await(parked);
  });
