import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import { makeFakeBackendProcess } from "./testUtils/FakeBackendProcess.ts";
import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

const runningConfig = {
  executablePath: "/electron",
  args: [],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: false,
  preflightFailure: Option.none(),
} satisfies DesktopBackendStartConfig;

function layerPool(
  labelRef: Ref.Ref<string>,
  backend?: Effect.Success<ReturnType<typeof makeFakeBackendProcess>>,
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        backend?.layer ??
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
          ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            backend === undefined
              ? Effect.die("unexpected HTTP request")
              : Effect.succeed(
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
          latest: Effect.succeedNone,
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        DesktopBrowserHost.layer,
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary: Effect.die("unexpected primary config resolve"),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
          currentBootstrapToken: Effect.die("unexpected bootstrap token read"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopWslEnvironment.layerTest(),
        ElectronDialog.layer,
        ElectronApp.layer,
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
          runMainContentsCommand: () => Effect.die("unexpected main contents command"),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

describe("DesktopBackendPool", () => {
  it.effect(
    "quitting all pool instances waits for a SIGTERM-ignoring registered backend to exit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* makeFakeBackendProcess(false);
          yield* Effect.gen(function* () {
            const pool = yield* DesktopBackendPool.DesktopBackendPool;
            const ready = yield* Deferred.make<void>();
            const instance = yield* pool.register({
              id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
              label: Effect.succeed("WSL (Ubuntu)"),
              configResolve: Effect.succeed(runningConfig),
              onReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
            });
            yield* instance.start;
            yield* backend.started;
            yield* Deferred.await(ready);
            const instances = yield* pool.list;
            const stopFiber = yield* Effect.forEach(
              instances,
              (entry) => entry.stop({ timeout: Duration.seconds(5) }),
              { concurrency: "unbounded" },
            ).pipe(Effect.forkChild);
            assert.equal(yield* Queue.take(backend.signals), "SIGTERM");
            yield* TestClock.adjust(Duration.seconds(5));
            assert.equal(yield* Queue.take(backend.signals), "SIGKILL");
            const completedBeforeExit = yield* Effect.sync(() => stopFiber.pollUnsafe());
            yield* TestClock.adjust(backend.killWait);
            yield* Fiber.join(stopFiber);

            assert.isTrue(
              completedBeforeExit === undefined,
              "pool quit completed before its registered backend exited",
            );
            assert.isFalse(yield* backend.isRunning);
            assert.deepEqual(backend.receivedSignals, ["SIGTERM", "SIGKILL"]);
            assert.isTrue(Option.isNone((yield* instance.snapshot).activePid));
          }).pipe(Effect.provide(layerPool(Ref.makeUnsafe("Windows"), backend)));
        }),
      ),
  );

  it.effect("unregister during pool quit does not interrupt sibling stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeFakeBackendProcess(false);
        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const id = DesktopBackendPool.BackendInstanceId("wsl:Ubuntu");
          const ready = yield* Deferred.make<void>();
          const siblingStarted = yield* Deferred.make<void>();
          const finishSibling = yield* Deferred.make<void>();
          let siblingCompleted = false;
          const instance = yield* pool.register({
            id,
            label: Effect.succeed("WSL (Ubuntu)"),
            configResolve: Effect.succeed(runningConfig),
            onReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
          });
          yield* instance.start;
          yield* backend.started;
          yield* Deferred.await(ready);
          const quitFiber = yield* Effect.all(
            [
              instance.stop({ timeout: Duration.seconds(5) }),
              Deferred.succeed(siblingStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishSibling)),
                Effect.andThen(
                  Effect.sync(() => {
                    siblingCompleted = true;
                  }),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* Deferred.await(siblingStarted);
          assert.equal(yield* Queue.take(backend.signals), "SIGTERM");
          const unregisterFiber = yield* pool.unregister(id).pipe(Effect.forkChild);
          yield* TestClock.adjust(Duration.seconds(5));
          assert.equal(yield* Queue.take(backend.signals), "SIGKILL");
          assert.isUndefined(quitFiber.pollUnsafe());
          assert.isUndefined(unregisterFiber.pollUnsafe());
          assert.isTrue(yield* backend.isRunning);
          yield* TestClock.adjust(backend.killWait);
          yield* Fiber.join(unregisterFiber);
          yield* Deferred.succeed(finishSibling, undefined);
          yield* Fiber.join(quitFiber);

          assert.isTrue(siblingCompleted);
          assert.isFalse(yield* backend.isRunning);
          assert.isTrue(Option.isNone((yield* instance.snapshot).activePid));
          assert.isTrue(Option.isNone(yield* pool.get(id)));
        }).pipe(Effect.provide(layerPool(Ref.makeUnsafe("Windows"), backend)));
      }),
    ),
  );

  it.effect("closing the pool scope stops a registered backend without explicit unregister", () =>
    Effect.gen(function* () {
      const backend = yield* makeFakeBackendProcess(true);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const ready = yield* Deferred.make<void>();
          const instance = yield* pool.register({
            id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
            label: Effect.succeed("WSL (Ubuntu)"),
            configResolve: Effect.succeed(runningConfig),
            onReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
          });
          yield* instance.start;
          yield* backend.started;
          yield* Deferred.await(ready);
          assert.isTrue(yield* backend.isRunning);
        }).pipe(Effect.provide(layerPool(Ref.makeUnsafe("Windows"), backend))),
      );

      assert.isFalse(yield* backend.isRunning);
      assert.deepEqual(backend.receivedSignals, ["SIGTERM"]);
    }),
  );

  it.effect("unregister waits for a running registered backend to exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeFakeBackendProcess(true);
        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const id = DesktopBackendPool.BackendInstanceId("wsl:Ubuntu");
          const ready = yield* Deferred.make<void>();
          const instance = yield* pool.register({
            id,
            label: Effect.succeed("WSL (Ubuntu)"),
            configResolve: Effect.succeed(runningConfig),
            onReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
          });
          yield* instance.start;
          yield* backend.started;
          yield* Deferred.await(ready);

          yield* pool.unregister(id);

          assert.isFalse(yield* backend.isRunning);
          assert.deepEqual(backend.receivedSignals, ["SIGTERM"]);
          assert.isTrue(Option.isNone(yield* pool.get(id)));
          assert.isTrue(Option.isNone((yield* instance.snapshot).activePid));
        }).pipe(Effect.provide(layerPool(Ref.makeUnsafe("Windows"), backend)));
      }),
    ),
  );

  it.effect("unregister stops the registered instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = DesktopBackendPool.BackendInstanceId("wsl:Ubuntu");
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const instance = yield* pool.register({
          id,
          label: Effect.succeed("WSL (Ubuntu)"),
          // A transient preflight failure leaves a restart fiber scheduled
          // without needing a real child process.
          configResolve: Effect.succeed({
            ...runningConfig,
            preflightFailure: Option.some({ reason: "WSL starting", fatal: false }),
          }),
        });
        yield* instance.start;
        assert.equal((yield* instance.snapshot).restartScheduled, true);

        yield* pool.unregister(id);

        const stopped = yield* instance.snapshot;
        assert.equal(stopped.desiredRunning, false);
        assert.equal(stopped.restartScheduled, false);
        assert.equal(Option.isNone(yield* pool.get(id)), true);
      }).pipe(Effect.provide(layerPool(Ref.makeUnsafe("Windows")))),
    ),
  );
});
