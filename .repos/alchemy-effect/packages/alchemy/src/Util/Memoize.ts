import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

/**
 * A lazily evaluated, memoized effect whose computation runs in a fiber of
 * its own, owned by `scope`.
 *
 * `Effect.cached` evaluates on the fiber of whichever caller gets there
 * first. When that caller is interrupted while others are waiting — a
 * concurrent plan cancelling sibling diffs — every waiter fails
 * interrupt-only and the cache stays poisoned for the rest of the process.
 * A computation that many fibers share must not have that failure mode: here
 * it runs detached from every caller, so interrupting a waiter never touches
 * it, and only closing `scope` cancels it (its waiters then see the
 * interruption, as they should).
 *
 * Requirements are captured from the first caller, exactly as
 * `Effect.cached` does.
 */
export const cachedInScope =
  (scope: Scope.Scope) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Effect.Effect<A, E>, never, R> =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      const deferred = yield* Deferred.make<A, E>();
      let started = false;
      return Effect.suspend(() => {
        if (started) return Deferred.await(deferred);
        started = true;
        return effect.pipe(
          Effect.provideContext(context),
          // `onExit` also runs on interruption, so the waiters always learn
          // how the computation ended.
          Effect.onExit((exit) => Deferred.done(deferred, exit)),
          // Not a child of the caller: the caller's interruption must not
          // reach it. The scope owns its lifetime instead.
          Effect.forkDetach,
          Effect.flatMap((fiber) =>
            Scope.addFinalizer(scope, Fiber.interrupt(fiber)),
          ),
          Effect.andThen(Deferred.await(deferred)),
        );
      });
    });
