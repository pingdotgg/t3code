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
    const started = yield* Deferred.make<void>();
    const refreshed = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
    const read = yield* makeStaleWhileRevalidate(
      Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
        if (call > 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          yield* Deferred.succeed(refreshed, yield* Effect.fiber);
        }
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
    yield* Deferred.await(started);
    assert.equal(yield* Ref.get(calls), 2);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.await(yield* Deferred.await(refreshed));
    assert.equal(yield* read, 2);
  }),
);

it.effect("shares one first scan that an interrupted caller does not cancel", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const release = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const read = yield* makeStaleWhileRevalidate(
      Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.tap(() => Deferred.succeed(started, undefined)),
        Effect.tap(() => Deferred.await(release)),
      ),
      "60 seconds",
    );

    // A connect that times out or disconnects mid-scan leaves the scan running.
    const interrupted = yield* read.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(interrupted);

    const next = yield* read.pipe(Effect.forkChild);
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
        Effect.filterOrElse(
          (call) => call !== 1,
          () => Effect.die("probe crashed"),
        ),
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
    const started = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
    const interrupted = yield* Deferred.make<void>();
    const refreshed = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
    const read = yield* makeStaleWhileRevalidate(
      Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((call) =>
          call === 2
            ? Effect.fiber.pipe(
                Effect.flatMap((fiber) => Deferred.succeed(started, fiber)),
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              )
            : Effect.succeed(call).pipe(
                Effect.tap(() =>
                  call === 3
                    ? Effect.fiber.pipe(
                        Effect.flatMap((fiber) => Deferred.succeed(refreshed, fiber)),
                      )
                    : Effect.void,
                ),
              ),
        ),
      ),
      "60 seconds",
    );

    assert.equal(yield* read, 1);
    yield* TestClock.adjust("61 seconds");
    assert.equal(yield* read, 1);
    yield* Deferred.await(started);
    assert.equal(yield* Ref.get(calls), 2);

    // The hung refresh times out, releasing the claim for the next caller.
    yield* TestClock.adjust("30 seconds");
    yield* Deferred.await(interrupted);
    yield* Fiber.await(yield* Deferred.await(started));
    assert.equal(yield* read, 1);
    yield* Fiber.await(yield* Deferred.await(refreshed));
    assert.equal(yield* Ref.get(calls), 3);
    assert.equal(yield* read, 3);
  }).pipe(Effect.scoped),
);

it.effect("interrupts a background refresh when the owning scope closes", () =>
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const scope = yield* Scope.make();
    const calls = yield* Ref.make(0);
    const read = yield* makeStaleWhileRevalidate(
      Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.filterOrElse(
          (call) => call === 1,
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        ),
      ),
      "60 seconds",
    ).pipe(Scope.provide(scope));

    yield* read;
    yield* TestClock.adjust("61 seconds");
    yield* read;
    yield* Deferred.await(started);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(interrupted);
  }),
);
