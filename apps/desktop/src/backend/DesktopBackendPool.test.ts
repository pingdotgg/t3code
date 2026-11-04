import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import type * as Electron from "electron";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

const backendConfig: DesktopBackendStartConfig = {
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
};

interface LayerPoolOverrides {
  readonly primaryExitCode?: number;
  readonly electronDialog?: ElectronDialog.ElectronDialog["Service"];
  readonly electronApp?: Partial<ElectronApp.ElectronApp["Service"]>;
  readonly mainWindow?: Electron.BrowserWindow;
}

function layerPool(
  labelRef: Ref.Ref<string>,
  overrides: LayerPoolOverrides = {},
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  const { primaryExitCode, mainWindow } = overrides;
  const main = Option.fromUndefinedOr(mainWindow);
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            primaryExitCode === undefined
              ? Effect.die("unexpected child process spawn")
              : Effect.succeed(
                  ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(123),
                    stdout: Stream.empty,
                    stderr: Stream.empty,
                    all: Stream.empty,
                    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(primaryExitCode)),
                    isRunning: Effect.succeed(false),
                    kill: () => Effect.void,
                    stdin: Sink.drain,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                    unref: Effect.succeed(Effect.void),
                  }),
                ),
          ),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            primaryExitCode === undefined ? Effect.die("unexpected HTTP request") : Effect.never,
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
          resolvePrimary:
            primaryExitCode === undefined
              ? Effect.die("unexpected primary config resolve")
              : Effect.succeed(backendConfig),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
          currentBootstrapToken: Effect.die("unexpected bootstrap token read"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopState.layer,
        DesktopWslEnvironment.layerTest(),
        overrides.electronDialog === undefined
          ? ElectronDialog.layer
          : Layer.succeed(ElectronDialog.ElectronDialog, overrides.electronDialog),
        Layer.succeed(ElectronApp.ElectronApp, {
          ...ElectronApp.make,
          ...overrides.electronApp,
        }),
        Layer.succeed(ElectronWindow.ElectronWindow, {
          create: () => Effect.die("unexpected window create"),
          main: Effect.succeed(main),
          currentMainOrFirst: Effect.succeed(main),
          focusedMainOrFirst: Effect.succeed(main),
          setMain: () => Effect.die("unexpected main window set"),
          clearMain: () => Effect.die("unexpected main window clear"),
          prepareReveal: () => Effect.succeed(false),
          reveal: () => Effect.die("unexpected window reveal"),
          sendAll: () => Effect.void,
          destroyAll: Effect.void,
          syncAllAppearance: (sync) =>
            Option.match(main, { onNone: () => Effect.void, onSome: sync }),
        } satisfies ElectronWindow.ElectronWindow["Service"]),
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
            ...backendConfig,
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

  // Linux shows a parentless error box behind the focused main window, so the user never sees it.
  it.effect("shows the unavailable T3 home error attached to the main window, then quits", () => {
    const mainWindow = { id: 1, isDestroyed: () => false } as unknown as Electron.BrowserWindow;
    const events: Array<
      | { readonly _tag: "Dialog"; readonly text: string; readonly owner?: Electron.BrowserWindow }
      | { readonly _tag: "Quit" }
    > = [];
    const quit = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const primary = yield* (yield* DesktopBackendPool.DesktopBackendPool).primary;
      yield* primary.start;
      yield* Deferred.await(quit);

      const dialog = events.find(
        (event) => event._tag === "Dialog" && event.text.includes("This T3 home is unavailable"),
      );
      assert.isDefined(dialog, "the T3 home unavailable error was never shown");
      assert.strictEqual(
        dialog._tag === "Dialog" ? dialog.owner : undefined,
        mainWindow,
        "the T3 home unavailable error must be attached to the main window",
      );
      assert.deepStrictEqual(
        events.map((event) => event._tag),
        ["Dialog", "Quit"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerPool(Ref.makeUnsafe("Windows"), {
          primaryExitCode: SERVER_EXIT_CODE_STATE_DIR_OWNED,
          electronDialog: {
            pickFolder: () => Effect.die("unexpected folder picker"),
            pickFiles: () => Effect.die("unexpected file picker"),
            showMessageBox: (options, owner) =>
              Effect.sync(() => {
                events.push({
                  _tag: "Dialog",
                  text: [options.title, options.message, options.detail].join("\n"),
                  ...(owner === undefined ? {} : { owner }),
                });
                return { response: 0, checkboxChecked: false };
              }),
            showErrorBox: (title, content) =>
              Effect.sync(() => {
                events.push({ _tag: "Dialog", text: `${title}\n${content}` });
              }),
          },
          electronApp: {
            quit: Effect.sync(() => {
              events.push({ _tag: "Quit" });
            }).pipe(Effect.andThen(Deferred.succeed(quit, undefined))),
          },
          mainWindow,
        }),
      ),
    );
  });

  it.effect("stops the primary backend while the unavailable T3 home error is still open", () => {
    const shown = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const primary = yield* (yield* DesktopBackendPool.DesktopBackendPool).primary;
      yield* primary.start;
      yield* Deferred.await(shown);
      yield* primary.stop();
      assert.equal((yield* primary.snapshot).desiredRunning, false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerPool(Ref.makeUnsafe("Windows"), {
          primaryExitCode: SERVER_EXIT_CODE_STATE_DIR_OWNED,
          electronDialog: {
            pickFolder: () => Effect.die("unexpected folder picker"),
            pickFiles: () => Effect.die("unexpected file picker"),
            showMessageBox: () =>
              Deferred.succeed(shown, undefined).pipe(Effect.andThen(Effect.never)),
            showErrorBox: () => Effect.die("unexpected error box"),
          },
          electronApp: { quit: Effect.die("quit before the error was dismissed") },
        }),
      ),
    );
  });

  it.effect("still quits when the unavailable T3 home error cannot be shown", () => {
    const quit = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const primary = yield* (yield* DesktopBackendPool.DesktopBackendPool).primary;
      yield* primary.start;
      yield* Deferred.await(quit);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerPool(Ref.makeUnsafe("Windows"), {
          primaryExitCode: SERVER_EXIT_CODE_STATE_DIR_OWNED,
          electronDialog: {
            pickFolder: () => Effect.die("unexpected folder picker"),
            pickFiles: () => Effect.die("unexpected file picker"),
            showMessageBox: (options) =>
              Effect.fail(
                new ElectronDialog.ElectronDialogShowMessageBoxError({
                  type: options.type ?? null,
                  titleLength: null,
                  messageLength: options.message.length,
                  detailLength: null,
                  buttonCount: 0,
                  cause: new Error("dialog unavailable"),
                }),
              ),
            showErrorBox: () => Effect.die("unexpected error box"),
          },
          electronApp: { quit: Deferred.succeed(quit, undefined).pipe(Effect.asVoid) },
        }),
      ),
    );
  });
});
