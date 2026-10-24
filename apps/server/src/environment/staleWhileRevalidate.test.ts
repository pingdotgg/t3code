import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makeStaleWhileRevalidate } from "./staleWhileRevalidate.ts";

it.effect("computes once, then answers from memory until the ttl lapses", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const read = yield* makeStaleWhileRevalidate(
      Ref.updateAndGet(calls, (count) => count + 1),
      "60 seconds",
    );

    assert.equal(yield* read, 1);
    yield* TestClock.adjust("59 seconds");
    assert.equal(yield* read, 1);
    assert.equal(yield* Ref.get(calls), 1);
  }).pipe(Effect.scoped),
);

it.effect("serves the stale value while one background refresh replaces it", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const release = yield* Deferred.make<void>();
    const read = yield* makeStaleWhileRevalidate(
      Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
        if (call > 1) yield* Deferred.await(release);
        return call;
      }),
      "60 seconds",
    );

    assert.equal(yield* read, 1);
    yield* TestClock.adjust("61 seconds");
    // The refresh is blocked, yet callers are answered immediately and only
    // one refresh starts however many callers arrive.
    assert.equal(yield* read, 1);
    assert.equal(yield* read, 1);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Ref.get(calls), 2);

    yield* Deferred.succeed(release, undefined);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* read, 2);
  }),
);

it.effect("shares one first scan that an interrupted caller does not cancel", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const release = yield* Deferred.make<void>();
    const read = yield* makeStaleWhileRevalidate(
      Ref.updateAndGet(calls, (count) => count + 1).pipe(Effect.tap(() => Deferred.await(release))),
      "60 seconds",
    );

    // A connect that times out or disconnects mid-scan leaves the scan running.
    const interrupted = yield* read.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(interrupted);

    const next = yield* read.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Fiber.join(next), 1);
    assert.equal(yield* Ref.get(calls), 1);
  }).pipe(Effect.scoped),
);

it.effect("starts over after a failed first scan", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const read = yield* makeStaleWhileRevalidate(
      Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((call) => (call === 1 ? Effect.die("probe crashed") : Effect.succeed(call))),
      ),
      "60 seconds",
    );

    assert.isTrue(Exit.isFailure(yield* Effect.exit(read)));
    assert.equal(yield* read, 2);
  }).pipe(Effect.scoped),
);

it.effect("abandons a hung refresh so a later call can start another", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const read = yield* makeStaleWhileRevalidate(
      Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((call) => (call === 2 ? Effect.never : Effect.succeed(call))),
      ),
      "60 seconds",
    );

    assert.equal(yield* read, 1);
    yield* TestClock.adjust("61 seconds");
    assert.equal(yield* read, 1);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Ref.get(calls), 2);

    // The hung refresh times out, releasing the claim for the next caller.
    yield* TestClock.adjust("30 seconds");
    assert.equal(yield* read, 1);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Ref.get(calls), 3);
    assert.equal(yield* read, 3);
  }).pipe(Effect.scoped),
);

it.effect("interrupts a background refresh when the owning scope closes", () =>
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>();
    const scope = yield* Scope.make();
    const calls = yield* Ref.make(0);
    const read = yield* makeStaleWhileRevalidate(
      Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((call) =>
          call === 1
            ? Effect.succeed(call)
            : Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        ),
      ),
      "60 seconds",
    ).pipe(Scope.provide(scope));

    yield* read;
    yield* TestClock.adjust("61 seconds");
    yield* read;
    yield* TestClock.adjust("1 second");
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(interrupted);
  }),
);
