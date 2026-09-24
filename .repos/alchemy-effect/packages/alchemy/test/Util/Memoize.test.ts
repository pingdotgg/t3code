import { cachedInScope } from "@/Util/Memoize.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

// `Effect.cached` runs the computation on the first caller's fiber, so
// interrupting that caller while others wait fails every waiter with an
// interrupt-only cause and leaves the cache poisoned. These pin the
// behaviour `cachedInScope` exists for.
describe("cachedInScope", () => {
  it.live("survives the first caller being interrupted", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      let runs = 0;
      const memo = yield* cachedInScope(scope)(
        Effect.sleep("100 millis").pipe(
          Effect.map(() => {
            runs++;
            return 42;
          }),
        ),
      );
      const owner = yield* Effect.forkChild(memo);
      yield* Effect.sleep("10 millis");
      const waiter = yield* Effect.forkChild(memo);
      yield* Effect.sleep("10 millis");
      yield* Fiber.interrupt(owner);

      expect(yield* Fiber.join(waiter)).toBe(42);
      expect(yield* memo).toBe(42);
      expect(runs).toBe(1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.live("runs once and shares failures with every waiter", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      let runs = 0;
      const memo = yield* cachedInScope(scope)(
        Effect.suspend(() => {
          runs++;
          return Effect.fail("boom");
        }),
      );
      const [a, b] = yield* Effect.all(
        [Effect.result(memo), Effect.result(memo)],
        { concurrency: "unbounded" },
      );
      expect(a._tag).toBe("Failure");
      expect(b._tag).toBe("Failure");
      expect(runs).toBe(1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.live("closing the scope cancels the computation for its waiters", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const memo = yield* cachedInScope(scope)(Effect.never);
      const waiter = yield* Effect.forkChild(memo);
      yield* Effect.sleep("10 millis");
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Fiber.await(waiter);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
        true,
      );
    }),
  );
});
