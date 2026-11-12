import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

// Models the spawner's release for a backend that ignores SIGTERM, without OS signals.
const makeFakeBackendProcess = Effect.fn("test.makeFakeBackendProcess")(function* () {
  const started = yield* Deferred.make<void>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const signals = yield* Queue.unbounded<"SIGTERM" | "SIGKILL">();
  let running = false;
  const killWait = Duration.seconds(1);
  const exit = Effect.sync(() => {
    running = false;
  }).pipe(Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))), Effect.asVoid);
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") {
          return yield* Effect.die("Expected a standard backend command");
        }
        const terminateGrace = Duration.fromInputUnsafe(command.options.forceKillAfter ?? 0);
        running = true;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Queue.offer(signals, "SIGTERM");
            yield* Effect.sleep(terminateGrace);
            yield* Queue.offer(signals, "SIGKILL");
            yield* Effect.sleep(killWait);
            yield* exit;
          }),
        );
        yield* Deferred.succeed(started, undefined);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          exitCode: Deferred.await(exited),
          isRunning: Effect.sync(() => running),
          kill: () => exit,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
  return {
    layer,
    started: Deferred.await(started),
    signals,
    isRunning: Effect.sync(() => running),
    killWait,
  };
});

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
        Path.layer,
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
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: "/home/test",
          platform: "linux",
          processArch: "x64",
          appVersion: "0.0.0",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath: "/missing/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
          Layer.orDie,
        ),
        DesktopState.layer,
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
  it.effect("unregister during pool quit does not interrupt sibling stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* makeFakeBackendProcess();
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

  it.effect("unregister stops the registered instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = DesktopBackendPool.BackendInstanceId("wsl:Ubuntu");
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const instance = yield* pool.register({
          id,
          label: Effect.succeed("WSL (Ubuntu)"),
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
