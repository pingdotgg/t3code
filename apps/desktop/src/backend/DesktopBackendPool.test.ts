import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

const windowsConfig: DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: [],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: false,
  preflightFailure: Option.none(),
};

function makeProcess(
  exitCode: ChildProcessSpawner.ChildProcessHandle["exitCode"],
): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

interface PoolTestInput {
  readonly label: Effect.Effect<string>;
  readonly settings?: DesktopAppSettings.DesktopSettings;
  readonly resolvePrimary?: Effect.Effect<
    DesktopBackendStartConfig,
    never,
    DesktopAppSettings.DesktopAppSettings
  >;
  readonly spawn?: (command: ChildProcess.Command) => ChildProcessSpawner.ChildProcessHandle;
  readonly showErrorBox?: ElectronDialog.ElectronDialog["Service"]["showErrorBox"];
  readonly onBackendExit?: Effect.Effect<void>;
  readonly onReadinessProbe?: Effect.Effect<void>;
}

function layerPool(
  input: PoolTestInput,
): Layer.Layer<
  | DesktopBackendPool.DesktopBackendPool
  | DesktopAppSettings.DesktopAppSettings
  | DesktopState.DesktopState
> {
  const layerConfiguration = Layer.effect(
    DesktopBackendConfiguration.DesktopBackendConfiguration,
    Effect.gen(function* () {
      const context = yield* Effect.context<DesktopAppSettings.DesktopAppSettings>();
      return {
        resolvePrimary:
          input.resolvePrimary?.pipe(Effect.provide(context)) ??
          Effect.die("unexpected primary config resolve"),
        resolvePrimaryLabel: input.label,
        resolveWsl: () => Effect.die("unexpected WSL config resolve"),
        currentBootstrapToken: Effect.die("unexpected bootstrap token read"),
      } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"];
    }),
  ).pipe(Layer.provideMerge(DesktopAppSettings.layerTest(input.settings)));
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            input.spawn
              ? Effect.sync(() => input.spawn!(command)).pipe(
                  // Like the real spawner, closing the run scope kills the process.
                  Effect.tap((handle) => Effect.addFinalizer(() => Effect.ignore(handle.kill()))),
                )
              : Effect.die("unexpected child process spawn"),
          ),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            input.spawn
              ? (input.onReadinessProbe ?? Effect.void).pipe(Effect.andThen(Effect.never))
              : Effect.die("unexpected HTTP request"),
          ),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => input.onBackendExit ?? Effect.void,
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
        layerConfiguration,
        DesktopState.layer,
        DesktopWslEnvironment.layerTest(),
        Layer.succeed(ElectronDialog.ElectronDialog, {
          ...ElectronDialog.make,
          ...(input.showErrorBox ? { showErrorBox: input.showErrorBox } : {}),
        }),
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
  it.effect("unregister stops the registered instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = DesktopBackendPool.BackendInstanceId("wsl:Ubuntu");
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const instance = yield* pool.register({
          id,
          label: Effect.succeed("WSL (Ubuntu)"),
          configResolve: Effect.succeed({
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
            preflightFailure: Option.some({ reason: "WSL starting", fatal: false }),
          } satisfies DesktopBackendStartConfig),
        });
        yield* instance.start;
        assert.equal((yield* instance.snapshot).restartScheduled, true);

        yield* pool.unregister(id);

        const stopped = yield* instance.snapshot;
        assert.equal(stopped.desiredRunning, false);
        assert.equal(stopped.restartScheduled, false);
        assert.equal(Option.isNone(yield* pool.get(id)), true);
      }).pipe(Effect.provide(layerPool({ label: Effect.succeed("Windows") }))),
    ),
  );

  it.effect("falls back to Windows for this launch when the WSL primary keeps crashing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawned = yield* Queue.unbounded<string>();
        const errors = yield* Ref.make<ReadonlyArray<string>>([]);
        const firstExit = yield* Deferred.make<void>();
        const layer = layerPool({
          label: Effect.succeed("WSL (Ubuntu)"),
          settings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            wslBackendEnabled: true,
            wslOnly: true,
          },
          resolvePrimary: Effect.gen(function* () {
            const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
            return settings.wslBackendEnabled && settings.wslOnly
              ? {
                  ...windowsConfig,
                  executablePath: "wsl.exe",
                  bootstrapDelivery: "stdin",
                  runningDistro: "Ubuntu",
                }
              : windowsConfig;
          }),
          // The WSL server dies on every start (missing libatomic.so.1); Windows stays up.
          spawn: (command) => {
            const executable = command._tag === "StandardCommand" ? command.command : "";
            Queue.offerUnsafe(spawned, executable);
            return makeProcess(
              executable === "wsl.exe"
                ? Effect.succeed(ChildProcessSpawner.ExitCode(1))
                : Effect.never,
            );
          },
          showErrorBox: (title) => Ref.update(errors, (shown) => [...shown, title]),
          onBackendExit: Deferred.succeed(firstExit, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          const primary = yield* pool.primary;
          yield* primary.start;
          yield* Deferred.await(firstExit);
          yield* TestClock.adjust(Duration.minutes(1));

          assert.deepEqual(yield* Ref.get(errors), ["WSL backend is still unavailable"]);
          const current = yield* settings.get;
          assert.isFalse(current.wslOnly, "wslOnly should be off in memory for this launch");
          // The manager's own restart after the third crash comes up on Windows.
          assert.deepEqual(yield* Queue.takeAll(spawned), [
            "wsl.exe",
            "wsl.exe",
            "wsl.exe",
            "/electron",
          ]);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("keeps reporting Failing when WSL-only already fell back to Windows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const errors = yield* Ref.make<ReadonlyArray<string>>([]);
        const firstExit = yield* Deferred.make<void>();
        const layer = layerPool({
          label: Effect.succeed("Windows"),
          settings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            wslBackendEnabled: true,
            wslOnly: true,
          },
          // WSL is unavailable, so the primary resolves to Windows despite wslOnly.
          resolvePrimary: Effect.succeed(windowsConfig),
          spawn: () => makeProcess(Effect.succeed(ChildProcessSpawner.ExitCode(1))),
          showErrorBox: (title) => Ref.update(errors, (shown) => [...shown, title]),
          onBackendExit: Deferred.succeed(firstExit, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.gen(function* () {
          const primary = yield* (yield* DesktopBackendPool.DesktopBackendPool).primary;
          yield* primary.start;
          yield* Deferred.await(firstExit);
          yield* TestClock.adjust(Duration.minutes(1));

          const startup = yield* SubscriptionRef.get(
            (yield* DesktopState.DesktopState).primaryBackendStartup,
          );
          assert.equal(startup._tag, "Failing");
          assert.deepEqual(yield* Ref.get(errors), []);
          assert.isTrue((yield* (yield* DesktopAppSettings.DesktopAppSettings).get).wslOnly);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("keeps a live WSL primary probing after a readiness timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawned = yield* Queue.unbounded<string>();
        const errors = yield* Ref.make<ReadonlyArray<string>>([]);
        const firstProbe = yield* Deferred.make<void>();
        const layer = layerPool({
          label: Effect.succeed("WSL (Ubuntu)"),
          settings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            wslBackendEnabled: true,
            wslOnly: true,
          },
          resolvePrimary: Effect.gen(function* () {
            const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
            return settings.wslBackendEnabled && settings.wslOnly
              ? { ...windowsConfig, executablePath: "wsl.exe", runningDistro: "Ubuntu" }
              : windowsConfig;
          }),
          // A cold WSL boot: the process stays up but is not ready within one readiness window.
          spawn: (command) => {
            Queue.offerUnsafe(spawned, command._tag === "StandardCommand" ? command.command : "");
            return makeProcess(Effect.never);
          },
          showErrorBox: (title) => Ref.update(errors, (shown) => [...shown, title]),
          onReadinessProbe: Deferred.succeed(firstProbe, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.gen(function* () {
          const primary = yield* (yield* DesktopBackendPool.DesktopBackendPool).primary;
          yield* primary.start;
          yield* Deferred.await(firstProbe);
          yield* TestClock.adjust(Duration.minutes(1));

          const startup = yield* SubscriptionRef.get(
            (yield* DesktopState.DesktopState).primaryBackendStartup,
          );
          assert.equal(startup._tag, "Failing");
          assert.deepEqual(yield* Ref.get(errors), []);
          assert.deepEqual(yield* Queue.takeAll(spawned), ["wsl.exe"]);
          assert.isTrue((yield* (yield* DesktopAppSettings.DesktopAppSettings).get).wslOnly);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
