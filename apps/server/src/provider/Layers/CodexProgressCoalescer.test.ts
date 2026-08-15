import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makeCodexProgressCoalescer } from "./CodexProgressCoalescer.ts";

describe("makeCodexProgressCoalescer", () => {
  it.effect("uses fixed windows and emits only the newest value from each lane", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emissions: Array<ReadonlyArray<string>> = [];
        const coalescer = yield* makeCodexProgressCoalescer<string, string>({
          emit: (values) =>
            Effect.sync(() => {
              emissions.push([...values]);
            }),
        });

        yield* coalescer.offerItem("child", "item-1");
        yield* TestClock.adjust("100 millis");
        yield* coalescer.offerItem("child", "item-2");
        yield* coalescer.offerTokenUsage("child", "usage-1");
        yield* TestClock.adjust("149 millis");
        yield* coalescer.offerTokenUsage("child", "usage-2");

        assert.deepStrictEqual(emissions, []);
        yield* TestClock.adjust("1 milli");
        assert.deepStrictEqual(emissions, [["item-2", "usage-2"]]);

        yield* coalescer.offerItem("child", "item-3");
        yield* coalescer.offerTokenUsage("child", "usage-3");
        yield* TestClock.adjust("100 millis");
        yield* coalescer.offerItem("child", "item-4");
        yield* TestClock.adjust("150 millis");

        assert.deepStrictEqual(emissions, [
          ["item-2", "usage-2"],
          ["item-4", "usage-3"],
        ]);
        assert.isTrue(emissions.every((values) => values.length <= 2));
      }),
    ),
  );

  it.live("does not let a blocked key prevent another key from flushing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emissions: Array<ReadonlyArray<string>> = [];
        const keyAStarted = yield* Deferred.make<void>();
        const releaseKeyA = yield* Deferred.make<void>();
        const keyBEmitted = yield* Deferred.make<void>();
        const coalescer = yield* makeCodexProgressCoalescer<string, string>({
          window: "1 hour",
          emit: (values) =>
            Effect.gen(function* () {
              if (values[0] === "a") {
                yield* Deferred.succeed(keyAStarted, undefined);
                yield* Deferred.await(releaseKeyA);
              }
              emissions.push([...values]);
              if (values[0] === "b") {
                yield* Deferred.succeed(keyBEmitted, undefined);
              }
            }),
        });

        yield* coalescer.offerItem("key-a", "a");
        yield* coalescer.offerItem("key-b", "b");
        const keyAFlush = yield* coalescer
          .flush("key-a")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(keyAStarted);

        const keyBFlush = yield* coalescer
          .flush("key-b")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(keyBEmitted).pipe(Effect.timeout("1 second"));
        yield* Fiber.join(keyBFlush);
        assert.deepStrictEqual(emissions, [["b"]]);

        yield* Deferred.succeed(releaseKeyA, undefined);
        yield* Fiber.join(keyAFlush);
        assert.deepStrictEqual(emissions, [["b"], ["a"]]);
      }),
    ),
  );

  it.effect("closes with its owning scope and ignores all later work", () =>
    Effect.gen(function* () {
      const emissions: Array<ReadonlyArray<string>> = [];
      const ownerScope = yield* Scope.make("sequential");
      const coalescer = yield* makeCodexProgressCoalescer<string, string>({
        window: "1 second",
        emit: (values) =>
          Effect.sync(() => {
            emissions.push([...values]);
          }),
      }).pipe(Effect.provideService(Scope.Scope, ownerScope));

      yield* coalescer.offerItem("child", "pending-item");
      yield* coalescer.offerTokenUsage("child", "pending-usage");
      yield* Scope.close(ownerScope, Exit.void);
      yield* TestClock.adjust("1 second");
      yield* coalescer.offerItem("child", "late-item");
      yield* coalescer.offerTokenUsage("child", "late-usage");
      yield* coalescer.flush("child");
      yield* coalescer.close;

      assert.deepStrictEqual(emissions, []);
    }),
  );

  it.effect("serializes a tick with flush and invalidates the flushed timer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emissions: Array<ReadonlyArray<string>> = [];
        const tickStarted = yield* Deferred.make<void>();
        const releaseTick = yield* Deferred.make<void>();
        const coalescer = yield* makeCodexProgressCoalescer<string, string>({
          emit: (values) =>
            Effect.gen(function* () {
              emissions.push([...values]);
              if (values[0] === "race") {
                yield* Deferred.succeed(tickStarted, undefined);
                yield* Deferred.await(releaseTick);
              }
            }),
        });

        yield* coalescer.offerItem("child", "race");
        const advanceToTick = yield* TestClock.adjust("250 millis").pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(tickStarted);
        const racingFlush = yield* coalescer
          .flush("child")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(releaseTick, undefined);
        yield* Fiber.join(advanceToTick);
        yield* Fiber.join(racingFlush);

        assert.strictEqual(emissions.flat().filter((value) => value === "race").length, 1);

        yield* coalescer.offerItem("child", "terminal");
        yield* TestClock.adjust("249 millis");
        yield* coalescer.flush("child");
        yield* coalescer.offerItem("child", "post-flush");
        yield* TestClock.adjust("1 milli");
        assert.isFalse(emissions.flat().includes("post-flush"));

        yield* TestClock.adjust("249 millis");
        assert.strictEqual(emissions.flat().filter((value) => value === "post-flush").length, 1);
        assert.deepStrictEqual(emissions, [["race"], ["terminal"], ["post-flush"]]);
      }),
    ),
  );

  it.effect("keeps pending values isolated between coalescer instances", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstEmissions: Array<ReadonlyArray<string>> = [];
        const secondEmissions: Array<ReadonlyArray<string>> = [];
        const first = yield* makeCodexProgressCoalescer<string, string>({
          window: "1 hour",
          emit: (values) =>
            Effect.sync(() => {
              firstEmissions.push([...values]);
            }),
        });
        const second = yield* makeCodexProgressCoalescer<string, string>({
          window: "1 hour",
          emit: (values) =>
            Effect.sync(() => {
              secondEmissions.push([...values]);
            }),
        });

        yield* first.offerItem("same-key", "first-instance");
        yield* second.offerItem("same-key", "second-instance");
        yield* Effect.all([first.flush("same-key"), second.flush("same-key")], {
          concurrency: "unbounded",
        });

        assert.deepStrictEqual(firstEmissions, [["first-instance"]]);
        assert.deepStrictEqual(secondEmissions, [["second-instance"]]);
      }),
    ),
  );
});
