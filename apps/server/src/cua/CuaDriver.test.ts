import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type CuaDriverMcpConfiguration,
  type DesktopCuaDriverReport,
} from "@t3tools/contracts";
import type { EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";

const mcp: CuaDriverMcpConfiguration = { command: "/driver", args: ["mcp"], environment: [] };

const makeHost = Effect.fnUntraced(function* () {
  const started = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const watching = yield* Deferred.make<void>();
  const ready = yield* Deferred.make<CuaDriverMcpConfiguration, CuaDriver.CuaDriverError>();
  const exited = yield* Deferred.make<void, CuaDriver.CuaDriverError>();
  let stops = 0;
  const host: CuaDriver.CuaDriverHost = {
    start: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(ready))),
    stop: Effect.sync(() => {
      stops++;
    }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)), Effect.asVoid),
    waitForExit: Deferred.succeed(watching, undefined).pipe(Effect.andThen(Deferred.await(exited))),
  };
  return { host, started, stopped, watching, ready, exited, stops: () => stops };
});

const makeService = Effect.fnUntraced(function* (
  createHost: Parameters<typeof CuaDriver.make>[0],
  initialEnabled = true,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const values = yield* settings.getSettings;
  const enabled = yield* Ref.make(initialEnabled);
  const changes = yield* PubSub.unbounded<boolean>();
  const service = yield* CuaDriver.make(createHost).pipe(
    Effect.provideService(ServerSettings.ServerSettingsService, {
      ...settings,
      getSettings: Ref.get(enabled).pipe(Effect.map((enableCua) => ({ ...values, enableCua }))),
      subscribeChanges: PubSub.subscribe(changes).pipe(
        Effect.map((subscription) =>
          Stream.fromSubscription(subscription).pipe(
            Stream.map((enableCua) => ({ ...values, enableCua })),
          ),
        ),
      ),
    }),
  );
  return {
    service,
    setEnabled: (value: boolean) =>
      Ref.set(enabled, value).pipe(Effect.andThen(PubSub.publish(changes, value))),
  };
});

it.layer(ServerSettings.layerTest())("CuaDriver lifecycle", (it) => {
  it.effect("defaults to disabled and never acquires a host before opt-in", () =>
    Effect.gen(function* () {
      expect(DEFAULT_SERVER_SETTINGS.enableCua).toBe(false);
      const { service } = yield* makeService(Effect.die("unexpected host acquisition"), false);
      expect(yield* service.enabled).toBe(false);
      expect(yield* service.acquire).toEqual(Option.none());
    }).pipe(Effect.scoped),
  );

  it.effect("shares slow preparation, survives one caller cancellation, and owns cleanup", () =>
    Effect.gen(function* () {
      const h = yield* makeHost();
      const preparing = yield* Deferred.make<void>();
      const prepared = yield* Deferred.make<void>();
      let creates = 0;
      yield* Effect.gen(function* () {
        const { service } = yield* makeService(
          Effect.gen(function* () {
            creates++;
            yield* Deferred.succeed(preparing, undefined);
            yield* Deferred.await(prepared);
            return h.host;
          }),
        );
        expect(creates).toBe(0);
        const first = yield* service.acquire.pipe(Effect.forkChild);
        yield* Deferred.await(preparing);
        const second = yield* service.acquire.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        yield* TestClock.adjust("31 seconds");
        yield* Deferred.succeed(prepared, undefined);
        yield* Deferred.succeed(h.ready, mcp);
        expect(yield* Fiber.join(second)).toEqual(Option.some(mcp));
        expect(yield* service.acquire).toEqual(Option.some(mcp));
        expect(creates).toBe(1);
        expect(h.stops()).toBe(0);
      }).pipe(Effect.scoped);
      expect(h.stops()).toBe(1);
    }),
  );

  it.effect("retries failed starts, clears the failure, and replaces a crashed connection", () =>
    Effect.gen(function* () {
      const failed = yield* makeHost();
      const crashed = yield* makeHost();
      const replacement = yield* makeHost();
      const hosts = [failed, crashed, replacement];
      let creates = 0;
      const { service } = yield* makeService(Effect.sync(() => hosts[creates++]!.host));
      yield* Deferred.fail(
        failed.ready,
        new CuaDriver.CuaDriverStartError({
          binaryPath: "/driver",
          cause: new Error("native start failed"),
        }),
      );
      expect(yield* service.acquire).toEqual(Option.none());
      expect(failed.stops()).toBe(1);
      expect(Option.isSome(yield* service.lastFailure)).toBe(true);
      yield* Deferred.succeed(crashed.ready, mcp);
      expect(yield* service.acquire).toEqual(Option.some(mcp));
      expect(yield* service.lastFailure).toEqual(Option.none());
      yield* Deferred.await(crashed.watching);
      const waitError = new CuaDriver.CuaDriverHostError({
        operation: "exit",
        cause: new Error("native waitForExit failed"),
      });
      yield* Deferred.fail(crashed.exited, waitError);
      yield* Deferred.await(crashed.stopped);
      expect(Option.getOrThrow(yield* service.lastFailure)).toBe(waitError);
      const next = { ...mcp, args: ["mcp", "--generation=next"] };
      yield* Deferred.succeed(replacement.ready, next);
      expect(yield* service.acquire).toEqual(Option.some(next));
      expect(creates).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.effect("disabling stops the active host and re-enabling starts a fresh one", () =>
    Effect.gen(function* () {
      const first = yield* makeHost();
      const second = yield* makeHost();
      let creates = 0;
      const h = yield* makeService(Effect.sync(() => (creates++ === 0 ? first.host : second.host)));
      yield* Deferred.succeed(first.ready, mcp);
      expect(yield* h.service.acquire).toEqual(Option.some(mcp));
      yield* h.setEnabled(false);
      yield* Deferred.await(first.stopped);
      expect(yield* h.service.acquire).toEqual(Option.none());
      expect(creates).toBe(1);
      yield* h.setEnabled(true);
      yield* Deferred.succeed(second.ready, mcp);
      expect(yield* h.service.acquire).toEqual(Option.some(mcp));
      expect(creates).toBe(2);
      expect(first.stops()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a revoked start cannot publish its late descriptor or stop its replacement", () =>
    Effect.gen(function* () {
      const first = yield* makeHost();
      const second = yield* makeHost();
      const lateFinished = yield* Deferred.make<void>();
      let creates = 0;
      const h = yield* makeService(
        Effect.sync(() =>
          creates++ === 0
            ? {
                ...first.host,
                start: first.host.start.pipe(
                  Effect.uninterruptible,
                  Effect.ensuring(Deferred.succeed(lateFinished, undefined)),
                ),
              }
            : second.host,
        ),
      );
      const pending = yield* h.service.acquire.pipe(Effect.forkChild);
      yield* Deferred.await(first.started);
      yield* h.setEnabled(false);
      yield* Deferred.await(first.stopped);
      expect(yield* Fiber.join(pending)).toEqual(Option.none());
      yield* h.setEnabled(true);
      const next = { ...mcp, command: "/replacement" };
      yield* Deferred.succeed(second.ready, next);
      expect(yield* h.service.acquire).toEqual(Option.some(next));
      yield* Deferred.succeed(first.ready, mcp);
      yield* Deferred.await(lateFinished);
      expect(yield* h.service.acquire).toEqual(Option.some(next));
      expect(first.stops()).toBe(1);
      expect(second.stops()).toBe(0);
    }).pipe(Effect.scoped),
  );
});

const nativeFixture = Effect.fnUntraced(function* () {
  const start = Promise.withResolvers<EmbeddedDriverConnection>();
  const stop = Promise.withResolvers<void>();
  const started = yield* Deferred.make<void>();
  const stopping = yield* Deferred.make<void>();
  const destroyed = yield* Deferred.make<void>();
  const connection: EmbeddedDriverConnection = {
    socketPath: "/socket",
    pid: 1,
    generation: "first",
    driverVersion: "test",
    contractVersion: "test",
    mcpProtocolVersion: "test",
    mcp: { command: mcp.command, args: [...mcp.args], environment: [...mcp.environment] },
  };
  let destroys = 0;
  let creates = 0;
  const factory = yield* CuaDriver.makeStandaloneHostFactory(
    Effect.succeed("/driver"),
    Effect.succeed({
      EmbeddedCuaDriverHost: class {
        constructor() {
          creates++;
        }
        start() {
          Deferred.doneUnsafe(started, Effect.void);
          return start.promise;
        }
        stop() {
          Deferred.doneUnsafe(stopping, Effect.void);
          return stop.promise;
        }
        waitForExit(_generation: string, options?: { signal: AbortSignal }) {
          return new Promise<never>((_resolve, reject) => {
            if (options?.signal.aborted) reject(new Error("aborted"));
            else
              options?.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
          });
        }
        uniffiDestroy() {
          destroys++;
          Deferred.doneUnsafe(destroyed, Effect.void);
        }
      },
    }),
  ).pipe(Effect.provide(NodeServices.layer));
  return {
    factory,
    connection,
    start,
    stop,
    started,
    stopping,
    destroyed,
    creates: () => creates,
    destroys: () => destroys,
  };
});

it.layer(ServerSettings.layerTest())("CuaDriver native ownership", (it) => {
  it.effect("times out native startup after 30 seconds and cleans up when it settles", () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const { service } = yield* makeService(f.factory);
      const acquiring = yield* service.acquire.pipe(Effect.forkChild);
      yield* Deferred.await(f.started);
      yield* TestClock.adjust("29 seconds");
      expect(yield* service.lastFailure).toEqual(Option.none());
      yield* TestClock.adjust("1 second");
      expect(yield* service.lastFailure).toEqual(
        Option.some(new CuaDriver.CuaDriverHostError({ operation: "timeout" })),
      );
      expect(f.destroys()).toBe(0);
      f.start.resolve(f.connection);
      yield* Deferred.await(f.stopping);
      f.stop.resolve();
      yield* Deferred.await(f.destroyed);
      expect(yield* Fiber.join(acquiring)).toEqual(Option.none());
      expect(f.destroys()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["start", "stop"] as const)(
    "bounds shutdown with native %s pending without destroying or reusing its owner",
    (pending) =>
      Effect.gen(function* () {
        const f = yield* nativeFixture();
        const scope = yield* Scope.make();
        const { service } = yield* makeService(f.factory).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const acquiring = yield* service.acquire.pipe(Effect.forkChild);
        yield* Deferred.await(f.started);
        if (pending === "stop") {
          f.start.resolve(f.connection);
          expect(yield* Fiber.join(acquiring)).toEqual(
            Option.some({ ...mcp, socketPath: "/socket" }),
          );
        }
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        if (pending === "stop") yield* Deferred.await(f.stopping);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(closing);
        expect(f.destroys()).toBe(0);
        expect(Exit.isFailure(yield* Effect.exit(f.factory))).toBe(true);
        expect(f.creates()).toBe(1);
        f.start.resolve(f.connection);
        yield* Deferred.await(f.stopping);
        expect(f.destroys()).toBe(0);
        f.stop.resolve();
        yield* Deferred.await(f.destroyed);
        const replacement = yield* f.factory;
        expect(f.creates()).toBe(2);
        yield* replacement.stop;
        expect(f.destroys()).toBe(2);
        expect(yield* service.acquire).toEqual(Option.none());
      }).pipe(Effect.scoped),
  );
});

const healthy: DesktopTelemetryReceiver.DesktopTelemetryReceiverHealth = {
  status: "healthy",
  lastSampleAt: Option.none(),
  lastError: Option.none(),
};

const desktopFixture = Effect.fnUntraced(function* (
  synchronous = false,
  healthChanges: Stream.Stream<DesktopTelemetryReceiver.DesktopTelemetryReceiverHealth> = Stream.empty,
  beforeHealth = Effect.void,
) {
  const reports = yield* PubSub.unbounded<DesktopCuaDriverReport>();
  const requested = yield* Deferred.make<string>();
  const disabled = yield* Deferred.make<void>();
  const watching = yield* Deferred.make<void>();
  const requests: boolean[] = [];
  const factory = yield* CuaDriver.makeDesktopHostFactory().pipe(
    Effect.provide(
      DesktopTelemetryReceiver.layerTest({
        health: Effect.succeed(healthy),
        subscribeHealth: beforeHealth.pipe(Effect.as({ latest: healthy, changes: healthChanges })),
        cuaReports: Stream.fromPubSub(reports),
        requestCuaDriver: (requestId, enabled) =>
          Effect.gen(function* () {
            requests.push(enabled);
            if (enabled) {
              yield* Deferred.succeed(requested, requestId);
              if (synchronous)
                yield* PubSub.publish(reports, {
                  version: 1,
                  type: "cuaDriverReport",
                  requestId,
                  status: "ready",
                  mcp,
                });
            } else {
              yield* PubSub.publish(reports, {
                version: 1,
                type: "cuaDriverReport",
                requestId,
                status: "stopped",
              });
              yield* Deferred.succeed(disabled, undefined);
            }
          }),
      }),
    ),
  );
  return {
    factory: factory.pipe(
      Effect.map((host) => ({
        ...host,
        waitForExit: Deferred.succeed(watching, undefined).pipe(Effect.andThen(host.waitForExit)),
      })),
    ),
    reports,
    requested,
    disabled,
    watching,
    requests,
  };
});

it.effect.each([false, true])(
  "uses the supplied desktop receiver for correlated replies (synchronous: %s) and acknowledged stop",
  (synchronous) =>
    Effect.gen(function* () {
      const { factory, reports, requested, requests } = yield* desktopFixture(synchronous);
      yield* Effect.gen(function* () {
        const { service } = yield* makeService(factory);
        const acquiring = yield* service.acquire.pipe(Effect.forkChild);
        const requestId = yield* Deferred.await(requested);
        yield* PubSub.publish(reports, {
          version: 1,
          type: "cuaDriverReport",
          requestId: "unrelated",
          status: "ready",
          mcp: { ...mcp, command: "/wrong" },
        });
        yield* PubSub.publish(reports, {
          version: 1,
          type: "cuaDriverReport",
          requestId,
          status: "ready",
          mcp,
        });
        expect(yield* Fiber.join(acquiring)).toEqual(Option.some(mcp));
        expect(yield* service.acquire).toEqual(Option.some(mcp));
      }).pipe(Effect.scoped);
      expect(requests).toEqual([true, false]);
    }).pipe(Effect.provide([ServerSettings.layerTest(), NodeCrypto.layer]), Effect.scoped),
);

it.effect("does not enable a desktop host retired while subscribing to health", () =>
  Effect.gen(function* () {
    const subscribing = yield* Deferred.make<void>();
    const releaseHealth = yield* Deferred.make<void>();
    const startFinished =
      yield* Deferred.make<Exit.Exit<CuaDriverMcpConfiguration, CuaDriver.CuaDriverError>>();
    const f = yield* desktopFixture(
      false,
      Stream.empty,
      Deferred.succeed(subscribing, undefined).pipe(Effect.andThen(Deferred.await(releaseHealth))),
    );
    const scope = yield* Scope.make();
    const { service } = yield* makeService(
      f.factory.pipe(
        Effect.map((host) => ({
          ...host,
          start: host.start.pipe(Effect.onExit((exit) => Deferred.succeed(startFinished, exit))),
        })),
      ),
    ).pipe(Effect.provideService(Scope.Scope, scope));
    const acquiring = yield* service.acquire.pipe(Effect.forkChild);
    yield* Deferred.await(subscribing);
    yield* Scope.close(scope, Exit.void);
    expect(yield* Fiber.join(acquiring)).toEqual(Option.none());
    yield* Deferred.succeed(releaseHealth, undefined);
    const result = yield* Deferred.await(startFinished);
    expect(result).toEqual(Exit.fail(new CuaDriver.CuaDriverHostError({ operation: "desktop" })));
    expect(f.requests).toEqual([]);
  }).pipe(Effect.provide([ServerSettings.layerTest(), NodeCrypto.layer]), Effect.scoped),
);

it.effect("preserves the desktop driver through degraded telemetry until the receiver stops", () =>
  Effect.gen(function* () {
    const streamQueue =
      yield* Queue.unbounded<
        Stream.Stream<DesktopTelemetryReceiver.DesktopTelemetryReceiverHealth>
      >();
    const processed = yield* Deferred.make<void>();
    const f = yield* desktopFixture(true, Stream.fromQueue(streamQueue).pipe(Stream.flatten));
    const { service } = yield* makeService(f.factory);
    const descriptor = yield* service.acquire;
    expect(descriptor).toEqual(Option.some(mcp));
    // Acquisition resolves before the exit watcher starts; wait so a false exit cannot go unnoticed.
    yield* Deferred.await(f.watching);
    yield* Queue.offer(
      streamQueue,
      Stream.make({ ...healthy, status: "degraded" as const }).pipe(
        // The next stream runs only after the health listener consumes the degraded event.
        Stream.concat(Stream.fromEffect(Deferred.succeed(processed, undefined)).pipe(Stream.drain)),
      ),
    );
    yield* Effect.raceFirst(Deferred.await(processed), Deferred.await(f.disabled));
    expect(f.requests).toEqual([true]);
    expect(yield* service.acquire).toEqual(descriptor);
    expect(f.requests).toEqual([true]);
    expect(yield* service.lastFailure).toEqual(Option.none());
    yield* Queue.offer(streamQueue, Stream.make({ ...healthy, status: "stopped" as const }));
    yield* Deferred.await(f.disabled);
    expect(f.requests).toEqual([true, false]);
    expect(yield* service.lastFailure).toEqual(
      Option.some(new CuaDriver.CuaDriverHostError({ operation: "exit" })),
    );
  }).pipe(Effect.provide([ServerSettings.layerTest(), NodeCrypto.layer]), Effect.scoped),
);

it.effect("uses an explicit driver path without consulting the installer", () =>
  Effect.gen(function* () {
    let binaryPath = "";
    const factory = yield* CuaDriver.makeStandaloneHostFactory(
      Effect.die("installer must not run"),
      Effect.succeed({
        EmbeddedCuaDriverHost: class {
          constructor(path: string) {
            binaryPath = path;
          }
          start() {
            return Promise.reject(new Error("unused"));
          }
          stop() {
            return Promise.resolve();
          }
          waitForExit() {
            return Promise.reject(new Error("unused"));
          }
          uniffiDestroy() {}
        },
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Environment, {
        T3CODE_CUA_DRIVER_PATH: "/explicit/driver",
      }),
    );
    const host = yield* factory;
    expect(binaryPath).toBe("/explicit/driver");
    yield* host.stop;
  }),
);
