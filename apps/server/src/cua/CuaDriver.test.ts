import { it } from "@effect/vitest";
import type { CuaDriverMcpConfiguration, DesktopCuaDriverReport } from "@t3tools/contracts";
import type { EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import { Deferred, Effect, Exit, Fiber, Option, PubSub, Ref, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";

import {
  CuaDriverError,
  makeCuaDriver,
  makeDesktopHostFactory,
  makeStandaloneHostFactory,
} from "./CuaDriver.ts";

const mcp: CuaDriverMcpConfiguration = { command: "/driver", args: ["mcp"], environment: [] };

const standaloneFixture = Effect.fn(function* () {
  const start = Promise.withResolvers<EmbeddedDriverConnection>();
  const stop = Promise.withResolvers<void>();
  const monitor = Promise.withResolvers<never>();
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const watching = Promise.withResolvers<AbortSignal>();
  const destroyed = Promise.withResolvers<void>();
  let creates = 0;
  let stops = 0;
  let destroys = 0;
  const factory = yield* makeStandaloneHostFactory("/driver", async () => ({
    EmbeddedCuaDriverHost: class {
      constructor() {
        creates++;
      }
      start() {
        started.resolve();
        return start.promise;
      }
      stop() {
        stops++;
        stopped.resolve();
        return stop.promise;
      }
      waitForExit(_generation: string, options?: { signal: AbortSignal }) {
        watching.resolve(options!.signal);
        return monitor.promise;
      }
      uniffiDestroy() {
        destroys++;
        destroyed.resolve();
      }
    },
  }));
  const connection: EmbeddedDriverConnection = {
    socketPath: "/socket",
    pid: 1,
    generation: "first",
    driverVersion: "test",
    contractVersion: "test",
    mcpProtocolVersion: "test",
    mcp: { command: mcp.command, args: [...mcp.args], environment: [...mcp.environment] },
  };
  return {
    factory,
    start,
    stop,
    monitor,
    started,
    stopped,
    watching,
    destroyed,
    connection,
    counts: () => ({ creates, stops, destroys }),
  };
});

describe("standalone Cua Driver ownership", () => {
  it.effect("retains a cancelled start until start and stop settle, with one cleanup", () =>
    Effect.gen(function* () {
      const f = yield* standaloneFixture();
      const host = yield* f.factory;
      const starting = yield* host.start.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => f.started.promise);
      yield* Fiber.interrupt(starting);
      const stopping = yield* host.stop.pipe(Effect.forkChild({ startImmediately: true }));
      const stoppingAgain = yield* host.stop.pipe(Effect.forkChild({ startImmediately: true }));
      expect(f.counts()).toEqual({ creates: 1, stops: 0, destroys: 0 });
      expect(Exit.isFailure(yield* Effect.exit(f.factory))).toBe(true);
      f.start.resolve(f.connection);
      yield* Effect.promise(() => f.stopped.promise);
      expect(f.counts()).toEqual({ creates: 1, stops: 1, destroys: 0 });
      f.stop.resolve();
      yield* Effect.all([Fiber.join(stopping), Fiber.join(stoppingAgain)]);
      expect(f.counts()).toEqual({ creates: 1, stops: 1, destroys: 1 });
      const replacement = yield* f.factory;
      yield* replacement.stop;
      expect(f.counts()).toEqual({ creates: 2, stops: 2, destroys: 2 });
    }),
  );

  it.effect("aborts the monitor and retains ownership after the stop waiter is cancelled", () =>
    Effect.gen(function* () {
      const f = yield* standaloneFixture();
      const host = yield* f.factory;
      f.start.resolve(f.connection);
      expect(yield* host.start).toEqual(mcp);
      const signal = yield* Effect.promise(() => f.watching.promise);
      const stopping = yield* host.stop.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => f.stopped.promise);
      expect(signal.aborted).toBe(true);
      yield* Fiber.interrupt(stopping);
      f.stop.resolve();
      expect(Exit.isFailure(yield* Effect.exit(f.factory))).toBe(true);
      expect(f.counts()).toEqual({ creates: 1, stops: 1, destroys: 0 });
      f.monitor.reject(new Error("monitor cancelled"));
      yield* Effect.promise(() => f.destroyed.promise);
      yield* host.stop;
      expect(f.counts()).toEqual({ creates: 1, stops: 1, destroys: 1 });
    }),
  );

  it.effect("destroys failed starts after a rejected native stop settles", () =>
    Effect.gen(function* () {
      const f = yield* standaloneFixture();
      const host = yield* f.factory;
      const starting = yield* host.start.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => f.started.promise);
      f.start.reject(new Error("start failed"));
      expect(Exit.isFailure(yield* Fiber.await(starting))).toBe(true);
      const stopping = yield* host.stop.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => f.stopped.promise);
      f.stop.reject(new Error("stop failed"));
      yield* Fiber.join(stopping);
      expect(f.counts()).toEqual({ creates: 1, stops: 1, destroys: 1 });
    }),
  );
});

const fixture = Effect.fn(function* (initialEnabled = true) {
  const enabled = yield* Ref.make(initialEnabled);
  const changes = yield* PubSub.unbounded<boolean>();
  const subscription = yield* PubSub.subscribe(changes);
  const started = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const result = yield* Deferred.make<CuaDriverMcpConfiguration, CuaDriverError>();
  const exited = yield* Deferred.make<void>();
  const watching = yield* Deferred.make<void>();
  let starts = 0;
  let stops = 0;
  const service = yield* makeCuaDriver({
    enabled: Ref.get(enabled),
    changes: Stream.fromSubscription(subscription),
    createHost: Effect.succeed({
      start: Effect.sync(() => {
        starts++;
      }).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(result)),
      ),
      stop: Effect.sync(() => {
        stops++;
      }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)), Effect.asVoid),
      waitForExit: Deferred.succeed(watching, undefined).pipe(
        Effect.andThen(Deferred.await(exited)),
      ),
    }),
  });
  const setEnabled = (value: boolean) =>
    Ref.set(enabled, value).pipe(Effect.andThen(PubSub.publish(changes, value)));
  return {
    service,
    started,
    stopped,
    result,
    exited,
    watching,
    setEnabled,
    starts: () => starts,
    stops: () => stops,
  };
});

describe("CuaDriver", () => {
  it.effect("bounds shutdown when the host never acknowledges stop", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const stopping = yield* Deferred.make<void>();
      const service = yield* makeCuaDriver({
        enabled: Effect.succeed(true),
        changes: Stream.empty,
        createHost: Effect.succeed({
          start: Effect.succeed(mcp),
          stop: Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Effect.never)),
          waitForExit: Effect.never,
        }),
      }).pipe(Scope.provide(scope));
      expect(yield* service.acquire).toEqual(Option.some(mcp));
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* Deferred.await(stopping);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(closing);
      expect(yield* service.acquire).toEqual(Option.none());
    }),
  );

  it.effect("late cleanup from a revoked start cannot stop its replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const enabled = yield* Ref.make(true);
        const changes = yield* PubSub.unbounded<boolean>();
        const subscription = yield* PubSub.subscribe(changes);
        const firstStarted = yield* Deferred.make<void>();
        const firstStopped = yield* Deferred.make<void>();
        const lateReady = yield* Deferred.make<CuaDriverMcpConfiguration>();
        const lateConsumed = yield* Deferred.make<void>();
        let count = 0;
        let oldStops = 0;
        let newStops = 0;
        const service = yield* makeCuaDriver({
          enabled: Ref.get(enabled),
          changes: Stream.fromSubscription(subscription),
          createHost: Effect.sync(() => {
            count++;
            return count === 1
              ? {
                  start: Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(lateReady)),
                    Effect.tap(() => Deferred.succeed(lateConsumed, undefined)),
                  ),
                  stop: Effect.sync(() => {
                    oldStops++;
                  }).pipe(Effect.andThen(Deferred.succeed(firstStopped, undefined)), Effect.asVoid),
                  waitForExit: Effect.never,
                }
              : {
                  start: Effect.succeed(mcp),
                  stop: Effect.sync(() => {
                    newStops++;
                  }),
                  waitForExit: Effect.never,
                };
          }),
        });
        const old = yield* service.acquire.pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* Ref.set(enabled, false);
        yield* PubSub.publish(changes, false);
        yield* Deferred.await(firstStopped);
        expect(yield* Fiber.join(old)).toEqual(Option.none());
        yield* Ref.set(enabled, true);
        expect(yield* service.acquire).toEqual(Option.some(mcp));
        yield* Deferred.succeed(lateReady, mcp);
        yield* Deferred.await(lateConsumed);
        expect(yield* service.acquire).toEqual(Option.some(mcp));
        expect(count).toBe(2);
        expect(oldStops).toBe(1);
        expect(newStops).toBe(0);
      }),
    ),
  );

  it.effect("does not start a disabled host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(false);
        expect(yield* f.service.enabled).toBe(false);
        expect(yield* f.service.acquire).toEqual(Option.none());
        expect(f.starts()).toBe(0);
      }),
    ),
  );

  it.effect("shares a lazy start across concurrent callers and owns shutdown", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const f = yield* fixture().pipe(Scope.provide(scope));
      const first = yield* f.service.acquire.pipe(Effect.forkChild);
      const second = yield* f.service.acquire.pipe(Effect.forkChild);
      yield* Deferred.await(f.started);
      yield* Deferred.succeed(f.result, mcp);
      expect(yield* Fiber.join(first)).toEqual(Option.some(mcp));
      expect(yield* Fiber.join(second)).toEqual(Option.some(mcp));
      expect(f.starts()).toBe(1);
      yield* Scope.close(scope, Exit.void);
      expect(f.stops()).toBe(1);
    }),
  );

  it.effect("caller cancellation cannot cancel the environment start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const caller = yield* f.service.acquire.pipe(Effect.forkChild);
        yield* Deferred.await(f.started);
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(f.result, mcp);
        expect(yield* f.service.acquire).toEqual(Option.some(mcp));
        expect(f.starts()).toBe(1);
      }),
    ),
  );

  it.effect("disabling during start revokes waiters and rejects late readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const caller = yield* f.service.acquire.pipe(Effect.forkChild);
        yield* Deferred.await(f.started);
        yield* f.setEnabled(false);
        yield* Deferred.await(f.stopped);
        expect(yield* Fiber.join(caller)).toEqual(Option.none());
        yield* Deferred.succeed(f.result, mcp);
        expect(yield* f.service.acquire).toEqual(Option.none());
        expect(f.stops()).toBe(1);
      }),
    ),
  );

  it.effect("shutdown during start resolves callers and stops the host", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const f = yield* fixture().pipe(Scope.provide(scope));
      const caller = yield* f.service.acquire.pipe(Effect.forkChild);
      yield* Deferred.await(f.started);
      yield* Scope.close(scope, Exit.void);
      expect(yield* Fiber.join(caller)).toEqual(Option.none());
      expect(f.stops()).toBe(1);
      expect(yield* f.service.acquire).toEqual(Option.none());
    }),
  );

  it.effect("cleans a failed start and allows the next session to retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const caller = yield* f.service.acquire.pipe(Effect.forkChild);
        yield* Deferred.await(f.started);
        yield* Deferred.fail(f.result, new CuaDriverError({ message: "test failure" }));
        expect(yield* Fiber.join(caller)).toEqual(Option.none());
        expect(f.stops()).toBe(1);
        expect(yield* f.service.acquire).toEqual(Option.none());
        expect(f.starts()).toBe(2);
        expect(f.stops()).toBe(2);
      }),
    ),
  );

  it.effect("bounds startup and cleans the failed attempt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const caller = yield* f.service.acquire.pipe(Effect.forkChild);
        yield* Deferred.await(f.started);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(caller)).toEqual(Option.none());
        expect(f.stops()).toBe(1);
      }),
    ),
  );

  it.effect("clears a crashed generation without restarting it automatically", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Deferred.succeed(f.result, mcp);
        expect(yield* f.service.acquire).toEqual(Option.some(mcp));
        yield* Deferred.await(f.watching);
        yield* Deferred.succeed(f.exited, undefined);
        yield* Deferred.await(f.stopped);
        expect(f.starts()).toBe(1);
        expect(yield* f.service.acquire).toEqual(Option.some(mcp));
        expect(f.starts()).toBe(2);
      }),
    ),
  );

  it.effect("subscribes before synchronous desktop replies and observes crashes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reports = yield* PubSub.unbounded<DesktopCuaDriverReport>();
        let startId = "";
        const factory = yield* makeDesktopHostFactory({
          cuaReports: Stream.fromPubSub(reports),
          requestCuaDriver: (requestId, enabled) => {
            if (enabled) startId = requestId;
            return PubSub.publish(
              reports,
              enabled
                ? { version: 1, type: "cuaDriverReport", requestId, status: "ready", mcp }
                : { version: 1, type: "cuaDriverReport", requestId, status: "stopped" },
            ).pipe(Effect.asVoid);
          },
        });
        const host = yield* factory;
        expect(yield* host.start).toEqual(mcp);
        yield* PubSub.publish(reports, {
          version: 1,
          type: "cuaDriverReport",
          requestId: startId,
          status: "unavailable",
        });
        yield* host.waitForExit;
        yield* host.stop;
      }),
    ),
  );
});
