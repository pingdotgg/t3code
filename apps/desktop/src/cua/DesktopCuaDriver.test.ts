import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopCuaDriverReport, DesktopCuaDriverRequest } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DesktopTelemetryPublisher } from "../telemetry/DesktopTelemetryPublisher.ts";
import { make, type DesktopCuaDriverDependencies } from "./DesktopCuaDriver.ts";

const descriptor = {
  command: "/native/driver",
  args: ["mcp", "--session", "opaque-session"],
  environment: [{ name: "CUA_SESSION", value: "private-session-token" }],
  socketPath: "/private/driver.sock",
};

const fixture = Effect.fn(function* (
  options: {
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    denyPermissions?: boolean;
    failFirstStart?: boolean;
    hold?: "start" | "stop" | "monitor";
  } = {},
) {
  const requests = yield* Queue.unbounded<DesktopCuaDriverRequest>();
  const reports = yield* Queue.unbounded<DesktopCuaDriverReport>();
  const starting = yield* Deferred.make<void>();
  const stopping = yield* Deferred.make<void>();
  const destroyed = yield* Queue.unbounded<void>();
  const gate = Promise.withResolvers<void>();
  const constructors: Array<{ path: string; bundleId: string }> = [];
  const exits: Array<() => void> = [];
  const holdMonitor = options.hold === "monitor";
  let allowed = !options.denyPermissions;
  let starts = 0;
  let stops = 0;
  let destroys = 0;
  const dependencies: DesktopCuaDriverDependencies = {
    loadElectron: async () => ({
      requestMacOSPermissions: () => ({ accessibility: allowed, screenRecording: allowed }),
      hasRequiredMacOSPermissions: (permissions) =>
        permissions.accessibility && permissions.screenRecording,
    }),
    loadEmbedded: async () => ({
      EmbeddedCuaDriverHost: class {
        readonly exit = Promise.withResolvers<{ generation: string; success: boolean }>();
        readonly first = constructors.length === 0;

        constructor(path: string, bundleId: string) {
          constructors.push({ path, bundleId });
        }
        async start() {
          starts++;
          Deferred.doneUnsafe(starting, Exit.void);
          if (this.first && options.hold === "start") await gate.promise;
          if (this.first && options.failFirstStart) throw new Error("private native failure");
          return {
            socketPath: descriptor.socketPath,
            pid: 123,
            generation: String(starts),
            driverVersion: "0.34.1",
            contractVersion: "1",
            mcpProtocolVersion: "1",
            mcp: {
              command: descriptor.command,
              args: descriptor.args,
              environment: descriptor.environment,
            },
          };
        }
        async stop() {
          stops++;
          Deferred.doneUnsafe(stopping, Exit.void);
          if (this.first && options.hold === "stop") await gate.promise;
        }
        waitForExit(generation: string, operation?: { signal: AbortSignal }) {
          const finish = () => this.exit.resolve({ generation, success: false });
          exits.push(finish);
          operation?.signal.addEventListener("abort", finish, { once: true });
          return this.first && holdMonitor
            ? gate.promise.then(() => ({ generation, success: false }))
            : this.exit.promise;
        }
        uniffiDestroy() {
          destroys++;
          Queue.offerUnsafe(destroyed, undefined);
        }
      },
    }),
  };
  const publisher = DesktopTelemetryPublisher.of({
    latest: Effect.succeedNone,
    changes: Stream.empty,
    encoded: Stream.empty,
    encodedForSource: () => Stream.empty,
    handleControlForSource: () => Effect.void,
    removeControlSource: () => Effect.void,
    updateRequests: Stream.empty,
    updateCommits: Stream.empty,
    updateCancellations: Stream.empty,
    publishUpdateReport: () => Effect.void,
    cuaRequests: Stream.fromQueue(requests),
    publishCuaReport: (report) => Queue.offer(reports, report).pipe(Effect.asVoid),
  });
  const environment = DesktopEnvironment.layer({
    dirname: "/app",
    homeDirectory: "/home/test",
    platform: options.platform ?? "linux",
    processArch: "x64",
    appVersion: "1.0.0",
    appPath: "/app",
    isPackaged: options.isPackaged ?? true,
    resourcesPath: "/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePath.layerPosix,
        DesktopConfig.layerTest({ T3CODE_DESKTOP_APP_USER_MODEL_ID: "codes.t3.host-test" }),
      ),
    ),
  );
  const driver = yield* make(dependencies).pipe(
    Effect.provideService(DesktopTelemetryPublisher, publisher),
    Effect.provide(environment),
  );
  yield* driver.listen;
  return {
    restart: driver.restart,
    request: (requestId: string, enabled = true) =>
      Queue.offer(requests, { version: 1, type: "cuaDriverRequest", requestId, enabled }),
    next: Queue.take(reports),
    pendingReports: Queue.size(reports),
    starting: Deferred.await(starting),
    stopping: Deferred.await(stopping),
    destroyed: Queue.take(destroyed),
    release: Effect.sync(() => gate.resolve()),
    grantPermissions: Effect.sync(() => {
      allowed = true;
    }),
    crash: Effect.sync(() => exits.at(-1)!()),
    constructors,
    counts: () => ({ starts, stops, destroys }),
  };
});

afterEach(() => vi.unstubAllEnvs());

describe("DesktopCuaDriver", () => {
  it.effect("hosts with the app identity, preserves the descriptor, reuses and releases once", () =>
    Effect.gen(function* () {
      vi.stubEnv("T3CODE_CUA_DRIVER_PATH", "/ignored-in-packaged-app");
      const test = yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture();
          yield* test.request("first");
          assert.deepEqual(yield* test.next, {
            version: 1,
            type: "cuaDriverReport",
            requestId: "first",
            status: "ready",
            mcp: descriptor,
          });
          assert.deepEqual(test.constructors, [
            { path: "/resources/cua-driver/cua-driver", bundleId: "codes.t3.host-test" },
          ]);
          yield* test.request("reuse");
          assert.deepEqual(yield* test.next, {
            version: 1,
            type: "cuaDriverReport",
            requestId: "reuse",
            status: "ready",
            mcp: descriptor,
          });
          yield* test.request("disable", false);
          assert.equal((yield* test.next).status, "stopped");
          yield* test.request("disable-again", false);
          assert.equal((yield* test.next).status, "stopped");
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
          yield* test.request("new-session");
          assert.equal((yield* test.next).status, "ready");
          return test;
        }),
      );
      assert.deepEqual(test.counts(), { starts: 2, stops: 2, destroys: 2 });
    }),
  );

  it.effect("requires a development override and uses it to host without a bundled driver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubEnv("T3CODE_CUA_DRIVER_PATH", " ");
        const missing = yield* fixture({ isPackaged: false });
        yield* missing.request("unconfigured");
        assert.equal((yield* missing.next).status, "unavailable");
        assert.isEmpty(missing.constructors);

        vi.stubEnv("T3CODE_CUA_DRIVER_PATH", " /dev/cua-driver ");
        const configured = yield* fixture({ isPackaged: false });
        yield* configured.request("configured");
        assert.equal((yield* configured.next).status, "ready");
        assert.deepEqual(configured.constructors, [
          { path: "/dev/cua-driver", bundleId: "codes.t3.host-test" },
        ]);
      }),
    ),
  );

  it.effect("denies missing macOS permissions and restarts the host after permission changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", denyPermissions: true });
        yield* test.request("denied");
        const denied = yield* test.next;
        assert.equal(denied.status, "unavailable");
        if (denied.status !== "ready")
          assert.match(denied.message ?? "", /Accessibility|Screen Recording/);
        assert.isEmpty(test.constructors);
        yield* test.grantPermissions;
        yield* test.restart;
        yield* test.request("granted");
        assert.equal((yield* test.next).status, "ready");
        assert.equal(test.constructors[0]?.path, "/resources/cua-driver");
        yield* test.restart;
        assert.deepEqual(yield* test.next, {
          version: 1,
          type: "cuaDriverReport",
          requestId: "granted",
          status: "stopped",
        });
        yield* test.request("fresh-permissions");
        assert.equal((yield* test.next).status, "ready");
        assert.deepEqual(test.counts(), { starts: 2, stops: 1, destroys: 1 });
      }),
    ),
  );

  it.effect(
    "releases failed starts and crashed hosts, correlates failure, and permits recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ failFirstStart: true });
          yield* test.request("failed-start");
          const failed = yield* test.next;
          assert.equal(failed.status, "unavailable");
          assert.equal(failed.requestId, "failed-start");
          assert.notInclude(JSON.stringify(failed), "private native failure");
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
          yield* test.request("recover");
          assert.equal((yield* test.next).status, "ready");
          yield* test.request("current-request");
          yield* test.next;
          yield* test.crash;
          const crashed = yield* test.next;
          assert.equal(crashed.status, "unavailable");
          assert.equal(crashed.requestId, "current-request");
          assert.deepEqual(test.counts(), { starts: 2, stops: 2, destroys: 2 });
          yield* test.request("after-crash");
          assert.equal((yield* test.next).status, "ready");
          assert.lengthOf(test.constructors, 3);
        }),
      ),
  );

  it.effect(
    "retains a timed-out native start through bounded shutdown and releases its late result",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const test = yield* fixture({ hold: "start" }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        yield* test.request("pending-start");
        yield* test.starting;
        yield* TestClock.adjust("23 seconds");
        assert.equal((yield* test.next).status, "unavailable");
        yield* test.request("cannot-replace");
        assert.equal((yield* test.next).status, "unavailable");
        assert.lengthOf(test.constructors, 1);
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(closing);
        assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
        yield* test.release;
        yield* test.destroyed;
        assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
        assert.equal(yield* test.pendingReports, 0);
      }),
  );

  it.effect.each(["stop", "monitor"] as const)(
    "bounds restart but retains ownership until the native %s settles",
    (hold) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ hold });
          yield* test.request("active");
          assert.equal((yield* test.next).status, "ready");
          const restarting = yield* test.restart.pipe(Effect.forkChild);
          yield* test.stopping;
          yield* TestClock.adjust("3 seconds");
          yield* Fiber.join(restarting);
          const report = yield* test.next;
          assert.equal(report.requestId, "active");
          assert.equal(report.status, "unavailable");
          yield* test.request("cannot-replace");
          assert.equal((yield* test.next).status, "unavailable");
          assert.lengthOf(test.constructors, 1);
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 0 });
          yield* test.release;
          yield* test.destroyed;
          yield* test.request("after-settlement");
          assert.equal((yield* test.next).status, "ready");
          assert.deepEqual(test.counts(), { starts: 2, stops: 1, destroys: 1 });
        }),
      ),
  );
});
