import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import {
  DesktopHostTelemetryMessage,
  type DesktopCuaDriverReport,
  type DesktopCuaDriverRequest,
} from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DesktopTelemetryPublisher } from "../telemetry/DesktopTelemetryPublisher.ts";
import { make, type DesktopCuaDriverDependencies } from "./DesktopCuaDriver.ts";

const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(DesktopHostTelemetryMessage));
const decodeMessage = Schema.decodeEffect(Schema.fromJsonString(DesktopHostTelemetryMessage));

const descriptor = {
  command: "/native/driver",
  args: ["mcp", "--session", "opaque"],
  environment: [{ name: "CUA_SESSION", value: "test-value" }],
};
const environmentLayer = (platform: NodeJS.Platform = "linux") =>
  DesktopEnvironment.layer({
    dirname: "/app",
    homeDirectory: "/home/test",
    platform,
    processArch: "x64",
    appVersion: "1.0.0",
    appPath: "/app",
    isPackaged: true,
    resourcesPath: "/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodePath.layerPosix, DesktopConfig.layerTest({}))));

const fixture = Effect.fn(function* (
  failStart = false,
  denyPermissions = false,
  control: { holdStart?: boolean; holdStop?: boolean } = {},
) {
  const requests = yield* Queue.unbounded<DesktopCuaDriverRequest>();
  const reports = yield* Queue.unbounded<DesktopCuaDriverReport>();
  const exits: Array<() => void> = [];
  const starting = yield* Queue.unbounded<void>();
  const stopping = yield* Queue.unbounded<void>();
  const destroyed = yield* Queue.unbounded<void>();
  const startGate = Promise.withResolvers<void>();
  const stopGate = Promise.withResolvers<void>();
  let starts = 0;
  let stops = 0;
  let destroys = 0;
  const dependencies: DesktopCuaDriverDependencies = {
    loadElectron: async () => ({
      requestMacOSPermissions: () => ({ accessibility: false, screenRecording: false }),
      hasRequiredMacOSPermissions: () => false,
    }),
    loadEmbedded: async () => ({
      EmbeddedCuaDriverHost: class {
        async start() {
          starts++;
          Queue.offerUnsafe(starting, undefined);
          if (control.holdStart) await startGate.promise;
          if (failStart) throw new Error("private host details");
          return {
            socketPath: "/socket",
            pid: 100,
            generation: String(starts),
            driverVersion: "0.24",
            contractVersion: "1",
            mcpProtocolVersion: "1",
            mcp: descriptor,
          };
        }
        async stop() {
          stops++;
          Queue.offerUnsafe(stopping, undefined);
          if (control.holdStop) await stopGate.promise;
        }
        uniffiDestroy() {
          destroys++;
          Queue.offerUnsafe(destroyed, undefined);
        }
        waitForExit(generation: string, options?: { signal: AbortSignal }) {
          return new Promise<{ generation: string; success: boolean }>((resolve) => {
            exits.push(() => resolve({ generation, success: false }));
            options?.signal.addEventListener(
              "abort",
              () => resolve({ generation, success: false }),
              { once: true },
            );
          });
        }
      },
    }),
  };
  const publisher = DesktopTelemetryPublisher.of({
    latest: Effect.succeedNone,
    changes: Stream.empty,
    encoded: Stream.empty,
    encodedForSource: () => Stream.empty,
    handleControl: () => Effect.void,
    handleControlForSource: () => Effect.void,
    removeControlSource: () => Effect.void,
    updateRequests: Stream.empty,
    updateCommits: Stream.empty,
    updateCancellations: Stream.empty,
    publishUpdateReport: () => Effect.void,
    cuaRequests: Stream.fromQueue(requests),
    publishCuaReport: (report) => Queue.offer(reports, report).pipe(Effect.asVoid),
  });
  const driver = yield* make(dependencies).pipe(
    Effect.provideService(DesktopTelemetryPublisher, publisher),
    Effect.provide(environmentLayer(denyPermissions ? "darwin" : "linux")),
  );
  yield* driver.listen;
  return {
    request: (requestId: string, enabled: boolean) =>
      Queue.offer(requests, { version: 1, type: "cuaDriverRequest", requestId, enabled }),
    next: Queue.take(reports),
    starting: Queue.take(starting),
    stopping: Queue.take(stopping),
    destroyed: Queue.take(destroyed),
    releaseStart: Effect.sync(() => startGate.resolve()),
    releaseStop: Effect.sync(() => stopGate.resolve()),
    exits,
    counts: () => ({ starts, stops, destroys }),
  };
});

describe("DesktopCuaDriver", () => {
  it.effect("returns the exact descriptor, reuses the host, and stops it once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture();
        yield* test.request("start", true);
        const ready = yield* test.next;
        const json = yield* encodeMessage(ready);
        assert.deepEqual(yield* decodeMessage(json), {
          version: 1,
          type: "cuaDriverReport",
          requestId: "start",
          status: "ready",
          mcp: descriptor,
        });
        yield* test.request("same", true);
        assert.equal((yield* test.next).requestId, "same");
        yield* test.request("stop", false);
        assert.equal((yield* test.next).status, "stopped");
        yield* test.request("stop-again", false);
        yield* test.next;
        assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
      }),
    ),
  );

  it.effect("reports a crash against the active request and allows a new host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture();
        yield* test.request("first", true);
        yield* test.next;
        yield* test.request("current", true);
        yield* test.next;
        yield* Effect.sync(() => test.exits[0]!());
        const report = yield* test.next;
        assert.equal(report.status, "unavailable");
        assert.equal(report.requestId, "current");
        yield* test.request("restart", true);
        assert.equal((yield* test.next).status, "ready");
        assert.deepEqual(test.counts(), { starts: 2, stops: 1, destroys: 1 });
      }),
    ),
  );

  it.effect("cleans up failed starts without exposing native error details", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture(true);
        yield* test.request("failed", true);
        const report = yield* test.next;
        assert.equal(report.status, "unavailable");
        if (report.status !== "ready")
          assert.equal(report.message?.includes("private host details"), false);
        assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
      }),
    ),
  );

  it.effect("reports missing permissions without constructing a native host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture(false, true);
        yield* test.request("permissions", true);
        const report = yield* test.next;
        assert.equal(report.status, "unavailable");
        if (report.status !== "ready") assert.include(report.message ?? "", "Accessibility");
        assert.deepEqual(test.counts(), { starts: 0, stops: 0, destroys: 0 });
      }),
    ),
  );

  it.effect(
    "times out a hanging start and cleans up its late result without publishing ready",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture(false, false, { holdStart: true });
          yield* test.request("hanging", true);
          yield* test.starting;
          yield* TestClock.adjust("23 seconds");
          assert.equal((yield* test.next).status, "unavailable");
          yield* test.request("disable", false);
          yield* TestClock.adjust("3 seconds");
          assert.equal((yield* test.next).status, "unavailable");
          assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
          yield* test.releaseStart;
          yield* test.destroyed;
          yield* test.request("disabled", false);
          const report = yield* test.next;
          assert.equal(report.requestId, "disabled");
          assert.equal(report.status, "stopped");
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
        }),
      ),
  );

  it.effect("bounds a hanging stop and prevents another native host until cleanup settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture(false, false, { holdStop: true });
        yield* test.request("start", true);
        yield* test.next;
        yield* test.request("stop", false);
        yield* test.stopping;
        yield* TestClock.adjust("3 seconds");
        assert.equal((yield* test.next).status, "unavailable");
        yield* test.request("too-soon", true);
        assert.equal((yield* test.next).status, "unavailable");
        assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 0 });
        yield* test.releaseStop;
        yield* test.destroyed;
        yield* test.request("restart", true);
        assert.equal((yield* test.next).status, "ready");
        assert.deepEqual(test.counts(), { starts: 2, stops: 1, destroys: 1 });
      }),
    ),
  );

  it.effect("closes its scope while start hangs and cleans up after late completion", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const test = yield* fixture(false, false, { holdStart: true }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      yield* test.request("start", true);
      yield* test.starting;
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(closing);
      assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
      yield* test.releaseStart;
      yield* test.destroyed;
      assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
    }),
  );

  it.effect("cleans up the active host when its scope closes", () =>
    Effect.gen(function* () {
      const test = yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture();
          yield* test.request("start", true);
          yield* test.next;
          return test;
        }),
      );
      assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
    }),
  );
});
