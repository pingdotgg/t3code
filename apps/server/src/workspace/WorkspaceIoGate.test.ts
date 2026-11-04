import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";

import * as WorkspaceIoGate from "./WorkspaceIoGate.ts";

const makeGate = () =>
  WorkspaceIoGate.makeWorkspaceIoGate({ maxInFlight: 2, timeout: "10 seconds" });

const reasonOf = (error: unknown) =>
  error instanceof PlatformError.PlatformError ? error.reason._tag : undefined;

// Stands in for a kernel call: it starts, then returns only when released.
const makeCall = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const settled = yield* Deferred.make<void>();
  const effect = Deferred.succeed(started, undefined).pipe(
    Effect.andThen(Deferred.await(release)),
    Effect.as("done"),
    Effect.ensuring(Deferred.succeed(settled, undefined)),
  );
  return { started, release, settled, effect };
});

it.effect("pauses only a hung root, then lets it work again once its call returns", () =>
  Effect.gen(function* () {
    const gate = makeGate();
    const hung = yield* makeCall;
    let laterCallsStarted = 0;
    const later = Effect.sync(() => (laterCallsStarted += 1)).pipe(Effect.as("ok"));

    const first = yield* gate
      .run("/a", "/a/favicon.svg", hung.effect)
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(hung.started);
    yield* TestClock.adjust("10 seconds");
    expect(reasonOf(yield* Fiber.join(first))).toBe("TimedOut");

    // No new thread for the hung root, and no wait: it fails at once.
    expect(reasonOf(yield* Effect.flip(gate.run("/a", "/a/icon.png", later)))).toBe("TimedOut");
    expect(laterCallsStarted).toBe(0);
    expect(yield* gate.run("/b", "/b/favicon.svg", later)).toBe("ok");

    yield* Deferred.succeed(hung.release, undefined);
    yield* Deferred.await(hung.settled);
    expect(gate.trackedRoots()).toBe(0);
    expect(yield* gate.run("/a", "/a/favicon.svg", later)).toBe("ok");
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("forgets a removed root at once, failing its waiters and leaving no state", () =>
  Effect.gen(function* () {
    const gate = makeGate();
    const inFlight = yield* makeCall;
    const running = yield* gate.run("/a", "/a/favicon.svg", inFlight.effect).pipe(Effect.forkChild);
    yield* Deferred.await(inFlight.started);
    // Starting now queues the waiter behind the in-flight call before forget runs.
    const waiting = yield* gate
      .run("/a", "/a/icon.png", Effect.succeed("ok"))
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));

    yield* gate.forget("/a");
    expect(reasonOf(yield* Fiber.join(waiting))).toBe("NotFound");
    expect(gate.trackedRoots()).toBe(0);
    // A project re-added at the same path starts fresh, even while the old call is still out.
    expect(yield* gate.run("/a", "/a/favicon.svg", Effect.succeed("fresh"))).toBe("fresh");

    yield* Deferred.succeed(inFlight.release, undefined);
    expect(yield* Fiber.join(running)).toBe("done");
    expect(gate.trackedRoots()).toBe(0);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("treats a missing root as gone, not hung", () =>
  Effect.gen(function* () {
    const gate = makeGate();
    let calls = 0;
    const missing = Effect.suspend(() => {
      calls += 1;
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "stat",
          pathOrDescriptor: "/gone",
        }),
      );
    });

    expect(reasonOf(yield* Effect.flip(gate.run("/gone", "/gone", missing)))).toBe("NotFound");
    expect(reasonOf(yield* Effect.flip(gate.run("/gone", "/gone", missing)))).toBe("NotFound");
    expect(calls).toBe(2);
    expect(gate.trackedRoots()).toBe(0);
  }),
);
