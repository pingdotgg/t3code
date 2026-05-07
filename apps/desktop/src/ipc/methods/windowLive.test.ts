import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as EffectPath from "effect/Path";
import type * as Electron from "electron";

import * as DesktopBackendManager from "../../main/DesktopBackendManager.ts";
import * as DesktopConfig from "../../main/DesktopConfig.ts";
import { layer as makeDesktopEnvironmentLayer } from "../../main/DesktopEnvironment.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindowIpc from "./window.ts";
import * as DesktopWindowIpcActionsLive from "./windowLive.ts";

const backendConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
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
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const noWindow = Effect.succeed(Option.none<Electron.BrowserWindow>());

function makeLayer(currentConfig: Option.Option<DesktopBackendManager.DesktopBackendStartConfig>) {
  return DesktopWindowIpcActionsLive.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeDesktopEnvironmentLayer({
          dirname: "/repo/apps/desktop/src",
          cwd: "/repo",
          platform: "darwin",
          processArch: "x64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath: "/missing/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(EffectPath.layer, DesktopConfig.layerTest({ T3CODE_HOME: "/tmp/t3" })),
          ),
        ),
        Layer.succeed(
          DesktopBackendManager.DesktopBackendManager,
          DesktopBackendManager.DesktopBackendManager.of({
            start: Effect.void,
            stop: () => Effect.void,
            shutdown: Effect.void,
            currentConfig: Effect.succeed(currentConfig),
            snapshot: Effect.succeed({
              desiredRunning: false,
              ready: false,
              activePid: Option.none(),
              restartAttempt: 0,
              restartScheduled: false,
              shuttingDown: false,
            }),
          }),
        ),
        Layer.succeed(ElectronDialog.ElectronDialog, {
          pickFolder: () => Effect.succeed(Option.none<string>()),
          confirm: () => Effect.succeed(false),
          showMessageBox: () =>
            Effect.succeed({
              response: 0,
              checkboxChecked: false,
            } satisfies Electron.MessageBoxReturnValue),
          showErrorBox: () => Effect.void,
        }),
        Layer.succeed(ElectronMenu.ElectronMenu, {
          setApplicationMenu: () => Effect.void,
          showContextMenu: () => Effect.succeed(Option.none<string>()),
          popupTemplate: () => Effect.void,
        }),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: () => Effect.succeed(false),
          copyText: () => Effect.void,
        }),
        Layer.succeed(ElectronTheme.ElectronTheme, {
          shouldUseDarkColors: Effect.succeed(false),
          setSource: () => Effect.void,
          onUpdated: () => Effect.void,
        }),
        Layer.succeed(ElectronWindow.ElectronWindow, {
          create: () => Effect.die(new Error("unexpected BrowserWindow creation")),
          main: noWindow,
          currentMainOrFirst: noWindow,
          focusedMainOrFirst: noWindow,
          setMain: () => Effect.void,
          clearMain: () => Effect.void,
          reveal: () => Effect.void,
          sendAll: () => Effect.void,
          destroyAll: Effect.void,
          syncAllAppearance: () => Effect.void,
        }),
      ),
    ),
  );
}

describe("DesktopWindowIpcActionsLive", () => {
  it.effect("returns null before the backend config has been resolved", () =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpc.DesktopWindowIpcActions;

      assert.equal(yield* window.getLocalEnvironmentBootstrap, null);
    }).pipe(Effect.provide(makeLayer(Option.none()))),
  );

  it.effect("derives the local bootstrap from the current backend config", () =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpc.DesktopWindowIpcActions;

      assert.deepEqual(yield* window.getLocalEnvironmentBootstrap, {
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
        bootstrapToken: "token",
      });
    }).pipe(Effect.provide(makeLayer(Option.some(backendConfig)))),
  );

  it.effect("uses wss when the backend base URL is https", () =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpc.DesktopWindowIpcActions;

      assert.equal((yield* window.getLocalEnvironmentBootstrap)?.wsBaseUrl, "wss://example.test/");
    }).pipe(
      Effect.provide(
        makeLayer(
          Option.some({
            ...backendConfig,
            httpBaseUrl: new URL("https://example.test"),
          }),
        ),
      ),
    ),
  );
});
