import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

const primaryConfig: DesktopBackendStartConfig = {
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

interface LayerPoolOptions {
  readonly resolvePrimary?: DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]["resolvePrimary"];
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly httpClient?: HttpClient.HttpClient;
  readonly entryExists?: boolean;
  readonly native?: NativeSpy;
}

interface NativeSpy {
  readonly errorBoxes: Array<{ readonly title: string; readonly content: string }>;
  readonly messageBoxes: Array<Electron.MessageBoxOptions>;
  readonly copied: Array<string>;
  // Resolves to the clicked button index; defaults to "Copy Diagnostics".
  readonly messageBoxResponse: Effect.Effect<number>;
}

const makeNativeSpy = (messageBoxResponse = Effect.succeed(0)): NativeSpy => ({
  errorBoxes: [],
  messageBoxes: [],
  copied: [],
  messageBoxResponse,
});

const BACKEND_LOG_PATH = "/logs/server-primary.log";

const exitingProcess = (onSpawn: () => void) =>
  ChildProcessSpawner.make(() =>
    Effect.sync(() => {
      onSpawn();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );

function layerPool(
  labelRef: Ref.Ref<string>,
  options: LayerPoolOptions = {},
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  const native = options.native;
  const entryExists = options.entryExists ?? true;
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: () => Effect.succeed(entryExists) }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          options.spawner ??
            ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          options.httpClient ?? HttpClient.make(() => Effect.die("unexpected HTTP request")),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              filePath: BACKEND_LOG_PATH,
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
          resolvePrimary: options.resolvePrimary ?? Effect.die("unexpected primary config resolve"),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
          currentBootstrapToken: Effect.die("unexpected bootstrap token read"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopWslEnvironment.layerTest(),
        native === undefined
          ? Layer.merge(ElectronDialog.layer, ElectronShell.layer)
          : Layer.merge(
              Layer.succeed(ElectronDialog.ElectronDialog, {
                ...ElectronDialog.make,
                showErrorBox: (title, content) =>
                  Effect.sync(() => {
                    native.errorBoxes.push({ title, content });
                  }),
                showMessageBox: (options) =>
                  Effect.sync(() => {
                    native.messageBoxes.push(options);
                  }).pipe(
                    Effect.andThen(native.messageBoxResponse),
                    Effect.map((response) => ({ response, checkboxChecked: false })),
                  ),
              }),
              Layer.succeed(ElectronShell.ElectronShell, {
                ...ElectronShell.make,
                copyText: (text) =>
                  Effect.sync(() => {
                    native.copied.push(text);
                  }),
              }),
            ),
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
          // A transient preflight failure leaves a restart fiber scheduled
          // without needing a real child process.
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

  it.effect("shows a visible error when the primary backend crashes before it is ready", () => {
    const native = makeNativeSpy();
    let spawnCount = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const primary = yield* pool.primary;
        yield* primary.start;
        yield* TestClock.adjust(Duration.minutes(1));

        assert.isAbove(spawnCount, 1);
        assert.isFalse((yield* primary.snapshot).ready);
        // The renderer is served by this backend, so only a native dialog can
        // tell the user why the window stays blank.
        assert.equal(native.messageBoxes.length, 1);
        assert.include(native.messageBoxes[0]!.detail, "code=1");
        assert.equal(native.copied.length, 1);
        assert.include(native.copied[0], "code=1");
        assert.include(native.copied[0], BACKEND_LOG_PATH);
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerPool(Ref.makeUnsafe("Windows"), {
              resolvePrimary: Effect.succeed(primaryConfig),
              spawner: exitingProcess(() => {
                spawnCount += 1;
              }),
              httpClient: HttpClient.make(() => Effect.never),
              native,
            }),
            TestClock.layer(),
          ),
        ),
      ),
    );
  });

  it.effect("keeps restarting while the failure dialog is open", () => {
    const native = makeNativeSpy(Effect.never);
    let spawnCount = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const primary = yield* pool.primary;
        yield* primary.start;
        yield* TestClock.adjust(Duration.minutes(1));

        assert.equal(native.messageBoxes.length, 1);
        assert.isAbove(spawnCount, 4);
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerPool(Ref.makeUnsafe("Windows"), {
              resolvePrimary: Effect.succeed(primaryConfig),
              spawner: exitingProcess(() => {
                spawnCount += 1;
              }),
              httpClient: HttpClient.make(() => Effect.never),
              native,
            }),
            TestClock.layer(),
          ),
        ),
      ),
    );
  });

  it.effect("surfaces a new crash loop after an explicit stop and start", () => {
    const native = makeNativeSpy();
    return Effect.scoped(
      Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const primary = yield* pool.primary;
        yield* primary.start;
        yield* TestClock.adjust(Duration.minutes(1));
        assert.equal(native.messageBoxes.length, 1);

        yield* primary.stop();
        yield* primary.start;
        yield* TestClock.adjust(Duration.minutes(1));

        assert.equal(native.messageBoxes.length, 2);
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerPool(Ref.makeUnsafe("Windows"), {
              resolvePrimary: Effect.succeed(primaryConfig),
              spawner: exitingProcess(() => {}),
              httpClient: HttpClient.make(() => Effect.never),
              native,
            }),
            TestClock.layer(),
          ),
        ),
      ),
    );
  });

  it.effect("still surfaces crashes that follow a bounded preflight fallback", () => {
    const native = makeNativeSpy();
    let resolveCount = 0;
    let spawnCount = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const primary = yield* pool.primary;
        yield* primary.start;
        yield* TestClock.adjust(Duration.minutes(2));

        assert.isAbove(spawnCount, 1);
        // The preflight fallback reports itself; the crash loop after it needs its own report.
        assert.equal(native.errorBoxes.length, 1);
        assert.equal(native.messageBoxes.length, 1);
        assert.include(native.messageBoxes[0]!.detail, "code=1");
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerPool(Ref.makeUnsafe("Windows"), {
              resolvePrimary: Effect.sync(() => {
                resolveCount += 1;
                return resolveCount <= 4
                  ? {
                      ...primaryConfig,
                      preflightFailure: Option.some({
                        reason: "WSL unreachable",
                        fatal: false,
                        retryLimit: 4,
                      }),
                    }
                  : primaryConfig;
              }),
              spawner: exitingProcess(() => {
                spawnCount += 1;
              }),
              httpClient: HttpClient.make(() => Effect.never),
              native,
            }),
            TestClock.layer(),
          ),
        ),
      ),
    );
  });

  it.effect("surfaces a missing server entry once", () => {
    const native = makeNativeSpy();
    return Effect.scoped(
      Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const primary = yield* pool.primary;
        yield* primary.start;
        yield* TestClock.adjust(Duration.minutes(2));

        assert.isAbove((yield* primary.snapshot).restartAttempt, 3);
        assert.equal(native.messageBoxes.length, 1);
        assert.include(native.copied[0], "missing server entry at /server/bin.mjs");
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerPool(Ref.makeUnsafe("Windows"), {
              resolvePrimary: Effect.succeed(primaryConfig),
              entryExists: false,
              native,
            }),
            TestClock.layer(),
          ),
        ),
      ),
    );
  });
});
