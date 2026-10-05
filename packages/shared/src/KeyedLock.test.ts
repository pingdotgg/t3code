import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as KeyedLock from "./KeyedLock.ts";

describe("KeyedLock", () => {
  it.effect("runs one holder of a key at a time, in arrival order", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(events, (current) => [...current, event]);
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();

      const first = yield* lock
        .withLock(
          "key",
          record("first:start").pipe(
            Effect.andThen(Deferred.succeed(firstEntered, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(record("first:end")),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);
      const second = yield* lock.withLock("key", record("second")).pipe(Effect.forkChild);
      const third = yield* lock.withLock("key", record("third")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* Ref.get(events), ["first:start"]);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.joinAll([first, second, third]);
      assert.deepStrictEqual(yield* Ref.get(events), [
        "first:start",
        "first:end",
        "second",
        "third",
      ]);
    }),
  );

  it.effect("runs holders of different keys concurrently", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      const entered = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const hold = (key: string) =>
        lock.withLock(key, Queue.offer(entered, key).pipe(Effect.andThen(Deferred.await(release))));

      const holders = yield* Effect.forEach(["a", "b"], hold, { concurrency: "unbounded" }).pipe(
        Effect.forkChild,
      );
      // Both enter while the other still holds its key.
      const both = new Set([yield* Queue.take(entered), yield* Queue.take(entered)]);
      assert.deepStrictEqual(both, new Set(["a", "b"]));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holders);
    }),
  );

  it.effect("keeps no lock for a key once its holders and waiters are gone", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const holder = yield* lock
        .withLock(
          "key",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      // A waiter that gives up and one that runs.
      const abandoned = yield* lock.withLock("key", Effect.void).pipe(Effect.forkChild);
      const waiting = yield* lock.withLock("key", Effect.void).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* lock.activeKeys, ["key"]);

      yield* Fiber.interrupt(abandoned);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.joinAll([holder, waiting]);
      // A holder that fails releases its key too.
      assert.strictEqual(
        yield* lock.withLock("other", Effect.fail("boom")).pipe(Effect.flip),
        "boom",
      );

      assert.deepStrictEqual(yield* lock.activeKeys, []);
    }),
  );

  it.effect("keeps working after the scope that made it closes", () =>
    Effect.gen(function* () {
      // Services built per request hand their lock to work that outlives the build.
      const lock = yield* Effect.scoped(KeyedLock.make<string>());
      assert.strictEqual(yield* lock.withLock("key", Effect.succeed("ran")), "ran");
    }),
  );

  it.effect("runs the effect in the caller's scope", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      const finalized = yield* Ref.make(false);
      const callerScope = yield* Scope.make();

      yield* lock
        .withLock(
          "key",
          Effect.addFinalizer(() => Ref.set(finalized, true)),
        )
        .pipe(Scope.provide(callerScope));
      // The finalizer belongs to the caller, so releasing the lock leaves it.
      assert.isFalse(yield* Ref.get(finalized));
      yield* Scope.close(callerScope, Exit.void);
      assert.isTrue(yield* Ref.get(finalized));
    }),
  );
});
