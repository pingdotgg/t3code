import { makeExecutionMemo } from "@/Runtime/ExecutionMemo";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

interface Pool {
  readonly id: number;
}

describe("makeExecutionMemo", () => {
  it.effect(
    "builds at most once per execution scope and releases at scope close",
    () =>
      Effect.gen(function* () {
        let builds = 0;
        const released: number[] = [];
        const accessor = yield* makeExecutionMemo(
          Effect.acquireRelease(
            Effect.sync((): Pool => ({ id: ++builds })),
            (pool) =>
              Effect.sync(() => {
                released.push(pool.id);
              }),
          ),
        );

        // Two accesses inside the same execution scope share one build.
        const scopeA = yield* Scope.make();
        const a1 = yield* accessor.pipe(Scope.provide(scopeA));
        const a2 = yield* accessor.pipe(Scope.provide(scopeA));
        expect(builds).toBe(1);
        expect(a2).toBe(a1);
        expect(released).toEqual([]);

        // A different execution scope builds its own instance.
        const scopeB = yield* Scope.make();
        const b1 = yield* accessor.pipe(Scope.provide(scopeB));
        expect(builds).toBe(2);
        expect(b1).not.toBe(a1);

        // Release finalizers fire when — and only when — the owning
        // execution scope closes.
        yield* Scope.close(scopeA, Exit.void);
        expect(released).toEqual([1]);
        yield* Scope.close(scopeB, Exit.void);
        expect(released).toEqual([1, 2]);

        // A fresh access on a fresh scope rebuilds (nothing is cached
        // across executions).
        const scopeC = yield* Scope.make();
        yield* accessor.pipe(Scope.provide(scopeC));
        expect(builds).toBe(3);
        yield* Scope.close(scopeC, Exit.void);
        expect(released).toEqual([1, 2, 3]);
      }),
  );

  it.effect("concurrent first accesses join a single build", () =>
    Effect.gen(function* () {
      let builds = 0;
      const accessor = yield* makeExecutionMemo(
        Effect.acquireRelease(
          // Asynchronous acquire so the second fiber arrives while the
          // first build is still in flight.
          Effect.sleep("10 millis").pipe(
            Effect.map((): Pool => ({ id: ++builds })),
          ),
          () => Effect.void,
        ),
      );

      const scope = yield* Scope.make();
      const fiber = yield* Effect.forkChild(
        Effect.all([accessor, accessor], {
          concurrency: 2,
        }).pipe(Scope.provide(scope)),
      );
      // `it.effect` runs under a TestClock — advance it so the in-flight
      // build's sleep elapses while both fibers are already waiting on it.
      yield* TestClock.adjust("10 millis");
      const [x, y] = yield* Fiber.join(fiber);
      expect(builds).toBe(1);
      expect(y).toBe(x);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("distinct call sites get distinct memo cells", () =>
    Effect.gen(function* () {
      let builds = 0;
      const build = Effect.sync(() => ++builds);
      const accessorA = yield* makeExecutionMemo(build);
      const accessorB = yield* makeExecutionMemo(build);

      const scope = yield* Scope.make();
      const a = yield* accessorA.pipe(Scope.provide(scope));
      const b = yield* accessorB.pipe(Scope.provide(scope));
      expect(a).toBe(1);
      expect(b).toBe(2);
      // ...but each cell still memoizes within the scope.
      expect(yield* accessorA.pipe(Scope.provide(scope))).toBe(1);
      expect(yield* accessorB.pipe(Scope.provide(scope))).toBe(2);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "Layer.build inside the memo ties layer finalizers to the execution scope",
    () =>
      Effect.gen(function* () {
        class Db extends Context.Service<Db, { readonly id: number }>()(
          "ExecutionMemoTest/Db",
        ) {}

        let builds = 0;
        let releases = 0;
        const dbLayer = Layer.effect(
          Db,
          Effect.acquireRelease(
            Effect.sync(() => ({ id: ++builds })),
            () =>
              Effect.sync(() => {
                releases++;
              }),
          ),
        );

        // The Drizzle.Postgres shape: build a Layer against the ambient
        // execution scope so its release fires when the event settles.
        const accessor = yield* makeExecutionMemo(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(dbLayer);
            return Context.get(ctx, Db);
          }),
        );

        const scope = yield* Scope.make();
        const d1 = yield* accessor.pipe(Scope.provide(scope));
        const d2 = yield* accessor.pipe(Scope.provide(scope));
        expect(builds).toBe(1);
        expect(d2).toBe(d1);
        expect(releases).toBe(0);

        yield* Scope.close(scope, Exit.void);
        expect(releases).toBe(1);
      }),
  );

  it.effect("build errors are surfaced and not poisoned across scopes", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const accessor = yield* makeExecutionMemo(
        Effect.suspend(() => {
          attempts++;
          return attempts === 1
            ? Effect.fail("boom" as const)
            : Effect.succeed(attempts);
        }),
      );

      const scopeA = yield* Scope.make();
      const first = yield* accessor.pipe(Scope.provide(scopeA), Effect.result);
      expect(Result.isFailure(first)).toBe(true);
      yield* Scope.close(scopeA, Exit.void);

      // A new execution scope re-runs the build rather than replaying the
      // stale failure forever.
      const scopeB = yield* Scope.make();
      const second = yield* accessor.pipe(Scope.provide(scopeB));
      expect(second).toBe(2);
      yield* Scope.close(scopeB, Exit.void);
    }),
  );
});
