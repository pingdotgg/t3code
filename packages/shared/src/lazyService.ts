import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/** Share acquisition in the owner's scope; retry failures on the next use. */
export const cacheInOwnerScope = <A, E, R>(make: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R | Scope.Scope>();
    const scope = yield* Scope.Scope;
    const lock = yield* Semaphore.make(1);
    let current: Fiber.Fiber<A, E> | undefined;
    const start = make.pipe(
      Effect.provideContext(context),
      Effect.forkIn(scope),
      Effect.tap((fiber) =>
        Effect.sync(() => {
          current = fiber;
          fiber.addObserver((exit) => {
            if (Exit.isFailure(exit) && current === fiber) current = undefined;
          });
        }),
      ),
    );
    const fiber = lock.withPermits(1)(
      Effect.suspend(() => (current ? Effect.succeed(current) : start)),
    );
    return fiber.pipe(Effect.flatMap(Fiber.join));
  });
