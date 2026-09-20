import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "./Scheduler.ts";

it.effect("keeps other sources running after a source defects", () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const receipts = yield* Queue.unbounded<string>();
    yield* scheduler.register(
      "broken",
      Queue.offer(receipts, "broken").pipe(Effect.andThen(Effect.die("fixture failure"))),
    );
    yield* scheduler.register("healthy", Queue.offer(receipts, "healthy").pipe(Effect.asVoid));
    for (let tick = 0; tick < 3; tick += 1) {
      if (tick > 0) yield* TestClock.adjust("5 seconds");
      assert.deepEqual([yield* Queue.take(receipts), yield* Queue.take(receipts)].sort(), [
        "broken",
        "healthy",
      ]);
    }
  }).pipe(Effect.provide(Scheduler.layer)),
);

it.effect("does not overlap slow work or hold up another source", () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const runs = yield* Ref.make(0);
    const receipts = yield* Queue.unbounded<void>();
    yield* scheduler.register(
      "slow",
      Ref.update(runs, (n) => n + 1).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
      ),
    );
    yield* scheduler.register("healthy", Queue.offer(receipts, undefined).pipe(Effect.asVoid));
    yield* Deferred.await(started);
    yield* Queue.take(receipts);
    yield* TestClock.adjust("10 seconds");
    yield* Queue.take(receipts);
    yield* Queue.take(receipts);
    assert.equal(yield* Ref.get(runs), 1);
    yield* Deferred.succeed(release, undefined);
    yield* TestClock.adjust("5 seconds");
    yield* Queue.take(receipts);
    assert.equal(yield* Ref.get(runs), 2);
  }).pipe(Effect.provide(Scheduler.layer)),
);

it.effect("unregisters closed sources and interrupts their in-flight work", () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const runs = yield* Ref.make(0);
    const registration = yield* Effect.scoped(
      scheduler
        .register(
          "scoped",
          Ref.update(runs, (n) => n + 1).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        )
        .pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(registration);
    yield* Deferred.await(stopped);
    const receipts = yield* Queue.unbounded<void>();
    yield* scheduler.register("remaining", Queue.offer(receipts, undefined).pipe(Effect.asVoid));
    yield* Queue.take(receipts);
    yield* TestClock.adjust("5 seconds");
    yield* Queue.take(receipts);
    assert.equal(yield* Ref.get(runs), 1);
  }).pipe(Effect.provide(Scheduler.layer)),
);
