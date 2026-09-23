import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import * as LookupResultCache from "./LookupResultCache.ts";

it.effect("shares pending lookups and expires results from completion", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let calls = 0;
    const cache = yield* LookupResultCache.make(
      (_key: string) =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(finish);
          return calls;
        }),
      { capacity: 2, timeToLive: () => "1 minute" },
    );
    const first = yield* Effect.forkChild(cache.get("a"));
    yield* Deferred.await(started);
    const second = yield* Effect.forkChild(cache.get("a"));
    yield* TestClock.adjust("2 minutes");
    yield* Deferred.succeed(finish, undefined);
    expect(yield* Fiber.join(first)).toBe(1);
    expect(yield* Fiber.join(second)).toBe(1);
    expect(yield* cache.get("a")).toBe(1);
    yield* TestClock.adjust("1 minute");
    expect(yield* cache.getOption("a")).toEqual(Option.none());
    expect(yield* cache.get("a")).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("preserves failure TTL and invalidates failed entries", () =>
  Effect.gen(function* () {
    let calls = 0;
    const cache = yield* LookupResultCache.make(
      (_key: string) =>
        Effect.suspend(() => {
          calls++;
          return Effect.fail("unavailable");
        }),
      { capacity: 2, timeToLive: (exit) => (Exit.isFailure(exit) ? "10 seconds" : "1 minute") },
    );
    expect(yield* Effect.flip(cache.get("a"))).toBe("unavailable");
    expect(yield* Effect.flip(cache.getOption("a"))).toBe("unavailable");
    expect(calls).toBe(1);
    yield* TestClock.adjust("10 seconds");
    yield* Effect.exit(cache.get("a"));
    expect(calls).toBe(2);
    yield* cache.invalidate("a");
    yield* Effect.exit(cache.get("a"));
    expect(calls).toBe(3);
  }).pipe(Effect.scoped),
);

it.effect("evicts the least recently read result and cannot repopulate an invalidated lookup", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let calls = 0;
    const cache = yield* LookupResultCache.make(
      (key: string) =>
        Effect.gen(function* () {
          const result = ++calls;
          if (key === "pending") {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
          }
          return result;
        }),
      { capacity: 2, timeToLive: () => "1 minute" },
    );
    yield* cache.get("a");
    yield* cache.get("b");
    yield* cache.get("a");
    yield* cache.get("c");
    expect(yield* cache.getOption("b")).toEqual(Option.none());
    const pending = yield* Effect.forkChild(cache.get("pending"));
    yield* Deferred.await(started);
    yield* cache.invalidate("pending");
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(pending);
    expect(yield* cache.getOption("pending")).toEqual(Option.none());
  }).pipe(Effect.scoped),
);

it.effect("a cancelled caller does not cancel another waiter", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<number>();
    const cache = yield* LookupResultCache.make(
      (_key: string) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          return yield* Deferred.await(finish);
        }),
      { capacity: 2, timeToLive: () => "1 minute" },
    );
    const first = yield* Effect.forkChild(cache.get("a"));
    yield* Deferred.await(started);
    yield* Fiber.interrupt(first);
    const second = yield* Effect.forkChild(cache.get("a"));
    yield* Deferred.succeed(finish, 42);
    expect(yield* Fiber.join(second)).toBe(42);
  }).pipe(Effect.scoped),
);
