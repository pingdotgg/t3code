import { assert, describe, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

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

function makeProcess(options?: {
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

interface LayerPoolOptions {
  readonly labelRef?: Ref.Ref<string>;
  readonly primaryConfig?: DesktopBackendStartConfig;
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly electronDialog?: ElectronDialog.ElectronDialog["Service"];
  readonly electronApp?: ElectronApp.ElectronApp["Service"];
}

function layerPool(
  optionsOrLabelRef?: Ref.Ref<string> | LayerPoolOptions,
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  const options: LayerPoolOptions =
    optionsOrLabelRef && "current" in (optionsOrLabelRef as object)
      ? { labelRef: optionsOrLabelRef as Ref.Ref<string> }
      : ((optionsOrLabelRef as LayerPoolOptions) ?? {});

  const labelRef = options.labelRef ?? Ref.makeUnsafe("Windows");
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Path.layer,
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            stateDir: "/tmp/state",
            backendCwd: "/repo",
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          options.spawner ??
            ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected HTTP request")),
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
          resolvePrimary: options.primaryConfig
            ? Effect.succeed(options.primaryConfig)
            : Effect.die("unexpected primary config resolve"),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
          bootstrapTokenForSecret: () => Effect.die("unexpected bootstrap token read"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopState.layer,
        DesktopWslEnvironment.layerTest(),
        options.electronDialog
          ? Layer.succeed(ElectronDialog.ElectronDialog, options.electronDialog)
          : ElectronDialog.layer,
        options.electronApp
          ? Layer.succeed(ElectronApp.ElectronApp, options.electronApp)
          : ElectronApp.layer,
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
      }).pipe(Effect.provide(layerPool(Ref.makeUnsafe("Windows")))),
    ),
  );

  it.effect("WSL primary exit code 78 shows distro error and quits without auto-attaching", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const errorBoxDeferred = yield* Deferred.make<{ title: string; content: string }>();
        const quitDeferred = yield* Deferred.make<void>();

        const layer = layerPool({
          primaryConfig: {
            executablePath: "wsl.exe",
            runningDistro: "Ubuntu",
            args: [],
            entryPath: "/server/bin.mjs",
            cwd: "/server",
            env: {},
            bootstrap: {
              mode: "desktop",
              noBrowser: true,
              port: 3774,
              host: "0.0.0.0",
              desktopBootstrapToken: "token",
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            },
            bootstrapDelivery: "stdin",
            extendEnv: false,
            httpBaseUrl: new URL("http://127.0.0.1:3774"),
            captureOutput: false,
            preflightFailure: Option.none(),
          },
          spawner: ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                exitCode: Effect.succeed(
                  ChildProcessSpawner.ExitCode(SERVER_EXIT_CODE_STATE_DIR_OWNED),
                ),
              }),
            ),
          ),
          electronDialog: {
            showErrorBox: (title: string, content: string) =>
              Deferred.succeed(errorBoxDeferred, { title, content }).pipe(Effect.asVoid),
          } as unknown as ElectronDialog.ElectronDialog["Service"],
          electronApp: {
            quit: Deferred.succeed(quitDeferred, undefined).pipe(Effect.asVoid),
          } as unknown as ElectronApp.ElectronApp["Service"],
        });

        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const primary = yield* pool.primary;
          yield* primary.start;

          const errorBox = yield* Deferred.await(errorBoxDeferred);
          yield* Deferred.await(quitDeferred);

          assert.equal(errorBox.title, "This T3 home is unavailable");
          assert.include(errorBox.content, "Another T3 Code server is using this distro's T3 home");
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect(
    "Native primary exit code 78 shows data directory error and quits if auto-attach fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const errorBoxDeferred = yield* Deferred.make<{ title: string; content: string }>();
          const quitDeferred = yield* Deferred.make<void>();

          const layer = layerPool({
            primaryConfig: {
              executablePath: process.execPath,
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
            },
            spawner: ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeProcess({
                  exitCode: Effect.succeed(
                    ChildProcessSpawner.ExitCode(SERVER_EXIT_CODE_STATE_DIR_OWNED),
                  ),
                }),
              ),
            ),
            electronDialog: {
              showErrorBox: (title: string, content: string) =>
                Deferred.succeed(errorBoxDeferred, { title, content }).pipe(Effect.asVoid),
            } as unknown as ElectronDialog.ElectronDialog["Service"],
            electronApp: {
              quit: Deferred.succeed(quitDeferred, undefined).pipe(Effect.asVoid),
            } as unknown as ElectronApp.ElectronApp["Service"],
          });

          yield* Effect.gen(function* () {
            const pool = yield* DesktopBackendPool.DesktopBackendPool;
            const primary = yield* pool.primary;
            yield* primary.start;

            const errorBox = yield* Deferred.await(errorBoxDeferred);
            yield* Deferred.await(quitDeferred);

            assert.equal(errorBox.title, "This T3 home is unavailable");
            assert.include(
              errorBox.content,
              "Another T3 Code server, such as the background service, is using this data directory",
            );
          }).pipe(Effect.provide(layer));
        }),
      ),
  );
});
