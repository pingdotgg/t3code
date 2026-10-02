import { describe, expect, it } from "@effect/vitest";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

describe("makeKeyedSerialExecutor", () => {
  it.effect("allows unrelated keys to run concurrently", () =>
    Effect.gen(function* () {
      const executor = yield* makeKeyedSerialExecutor<string>();
      const arrivals = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const run = (key: string) =>
        executor.withLock(
          key,
          Queue.offer(arrivals, key).pipe(Effect.andThen(Deferred.await(release))),
        );

      const fibers = yield* Effect.forEach(["a", "b"], run, {
        concurrency: "unbounded",
        discard: false,
      }).pipe(Effect.forkChild);
      const observed = [yield* Queue.take(arrivals), yield* Queue.take(arrivals)];
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fibers);
      expect(new Set(observed)).toEqual(new Set(["a", "b"]));
    }).pipe(Effect.timeout("1 second")),
  );

  it.effect("serializes work for the same key", () =>
    Effect.gen(function* () {
      const executor = yield* makeKeyedSerialExecutor<string>();
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const events = yield* Ref.make<Array<string>>([]);

      const first = yield* executor
        .withLock(
          "thread",
          Ref.update(events, (current) => [...current, "first:start"]).pipe(
            Effect.andThen(Deferred.succeed(firstEntered, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(Ref.update(events, (current) => [...current, "first:end"])),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);
      const second = yield* executor
        .withLock(
          "thread",
          Ref.update(events, (current) => [...current, "second:start"]),
        )
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(yield* Ref.get(events)).toEqual(["first:start"]);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Ref.get(events)).toEqual(["first:start", "first:end", "second:start"]);
    }).pipe(Effect.timeout("1 second")),
  );
});
