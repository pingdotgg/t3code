import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as TestClock from "effect/testing/TestClock";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendSnapshot, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

function makeStubInstance(
  id: DesktopBackendPool.BackendInstanceId,
  label: string,
): DesktopBackendPool.DesktopBackendInstance {
  const snapshot: DesktopBackendSnapshot = {
    desiredRunning: false,
    ready: false,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  };
  return {
    id,
    label: Effect.succeed(label),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

function makePoolLayer(
  labelRef: Ref.Ref<string>,
  spawner = ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
            ),
          ),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => Effect.void,
              discardSession: Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
        Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
          latest: Effect.succeed(Option.none()),
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary: Effect.succeed(backendConfig),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopWslEnvironment.layerTest(),
        ElectronDialog.layer,
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected window create"),
          ensureMain: Effect.die("unexpected window ensure"),
          revealOrCreateMain: Effect.die("unexpected window reveal"),
          activate: Effect.die("unexpected window activate"),
          createMainIfBackendReady: Effect.die("unexpected window create"),
          showConnectingSplash: Effect.void,
          handleBackendReady: () => Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          prepareCaptureReveal: Effect.void,
          dispatchMenuAction: () => Effect.die("unexpected menu action"),
          dispatchSnapShotEvent: () => Effect.void,
          zoomMain: () => Effect.die("unexpected zoom"),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

const backendConfig: DesktopBackendStartConfig = {
  executablePath: "/backend",
  args: [],
  entryPath: "/backend",
  cwd: "/",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3-test",
    host: "127.0.0.1",
    desktopBootstrapToken: "test-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  extendEnv: false,
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: false,
  preflightFailure: Option.none(),
};

const secondarySpec: DesktopBackendPool.BackendInstanceSpec = {
  id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
  label: Effect.succeed("WSL (Ubuntu)"),
  configResolve: Effect.succeed(backendConfig),
};

const makeProcessHarness = Effect.gen(function* () {
  const started = yield* Queue.unbounded<{
    readonly pid: number;
    readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  }>();
  const alive = new Set<number>();
  let nextPid = 100;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      const pid = nextPid++;
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Effect.acquireRelease(
        Effect.sync(() => alive.add(pid)),
        () =>
          Effect.gen(function* () {
            alive.delete(pid);
            yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
          }),
      );
      yield* Queue.offer(started, { pid, exit });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Deferred.await(exit),
        isRunning: Effect.sync(() => alive.has(pid)),
        kill: () => Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const label = yield* Ref.make("Windows");
  return { started, alive, layer: makePoolLayer(label, spawner) };
});

describe("DesktopBackendPool", () => {
  it.effect("unregister stops only the secondary and allows it to be enabled again", () =>
    Effect.gen(function* () {
      const harness = yield* makeProcessHarness;
      yield* Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const primary = yield* pool.primary;
        yield* primary.start;
        const primaryProcess = yield* Queue.take(harness.started);
        const secondary = yield* pool.register(secondarySpec);
        yield* secondary.start;
        const secondaryProcess = yield* Queue.take(harness.started);

        yield* pool.unregister(secondary.id);

        assert.isFalse((yield* secondary.snapshot).desiredRunning);
        assert.isTrue(Option.isNone((yield* secondary.snapshot).activePid));
        assert.isFalse((yield* secondary.snapshot).restartScheduled);
        assert.isTrue(Option.isNone(yield* pool.get(secondary.id)));
        assert.isFalse(harness.alive.has(secondaryProcess.pid));
        assert.deepEqual([...harness.alive], [primaryProcess.pid]);
        assert.isTrue((yield* primary.snapshot).desiredRunning);

        const replacement = yield* pool.register(secondarySpec);
        yield* replacement.start;
        const replacementProcess = yield* Queue.take(harness.started);
        assert.notEqual(replacementProcess.pid, secondaryProcess.pid);
        assert.sameMembers([...harness.alive], [primaryProcess.pid, replacementProcess.pid]);
        yield* pool.unregister(replacement.id);
        assert.deepEqual([...harness.alive], [primaryProcess.pid]);
      }).pipe(Effect.provide(harness.layer));
      assert.equal(harness.alive.size, 0);
    }),
  );

  it.effect("unregister cancels a pending secondary restart", () =>
    Effect.gen(function* () {
      const label = yield* Ref.make("Windows");
      let resolves = 0;
      yield* Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const secondary = yield* pool.register({
          ...secondarySpec,
          configResolve: Effect.sync(() => {
            resolves += 1;
            return {
              ...backendConfig,
              preflightFailure: Option.some({ reason: "WSL is starting", fatal: false }),
            };
          }),
        });
        yield* secondary.start;
        assert.isTrue((yield* secondary.snapshot).restartScheduled);
        yield* pool.unregister(secondary.id);
        assert.isFalse((yield* secondary.snapshot).desiredRunning);
        assert.isFalse((yield* secondary.snapshot).restartScheduled);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.equal(resolves, 1);
      }).pipe(Effect.provide(makePoolLayer(label)));
    }),
  );

  it.effect("pool shutdown releases running primary and secondary processes", () =>
    Effect.gen(function* () {
      const harness = yield* makeProcessHarness;
      yield* Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        yield* (yield* pool.primary).start;
        yield* Queue.take(harness.started);
        yield* (yield* pool.register(secondarySpec)).start;
        yield* Queue.take(harness.started);
        assert.equal(harness.alive.size, 2);
      }).pipe(Effect.provide(harness.layer));
      assert.equal(harness.alive.size, 0);
    }),
  );

  it.effect("layerTest exposes registered instances by id", () =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const fetchedPrimary = yield* pool.get(DesktopBackendPool.PRIMARY_INSTANCE_ID);
      const fetchedWsl = yield* pool.get(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"));
      const fetchedMissing = yield* pool.get(DesktopBackendPool.BackendInstanceId("missing"));
      const all = yield* pool.list;
      const resolvedPrimary = yield* pool.primary;

      assert.equal(yield* Option.getOrThrow(fetchedPrimary).label, "Windows");
      assert.equal(yield* Option.getOrThrow(fetchedWsl).label, "WSL (Ubuntu)");
      assert.isTrue(Option.isNone(fetchedMissing));
      assert.lengthOf(all, 2);
      // First instance becomes primary in layerTest so single-instance
      // stubs don't have to wire an explicit primary.
      assert.equal(resolvedPrimary.id, DesktopBackendPool.PRIMARY_INSTANCE_ID);
    }).pipe(
      Effect.provide(
        DesktopBackendPool.layerTest([
          makeStubInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, "Windows"),
          makeStubInstance(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"), "WSL (Ubuntu)"),
        ]),
      ),
    ),
  );

  it.effect("layerTest dies when no instances are supplied", () =>
    Effect.exit(
      Effect.gen(function* () {
        yield* DesktopBackendPool.DesktopBackendPool;
      }).pipe(Effect.provide(DesktopBackendPool.layerTest([]))),
    ).pipe(Effect.map((exit) => assert.equal(exit._tag, "Failure"))),
  );

  it.effect("resolves the primary label lazily after pool layer construction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const labelRef = yield* Ref.make("Windows");
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
          Effect.provide(makePoolLayer(labelRef)),
        );
        const primary = yield* pool.primary;

        yield* Ref.set(labelRef, "WSL (Ubuntu)");

        assert.equal(yield* primary.label, "WSL (Ubuntu)");
      }),
    ),
  );
});
