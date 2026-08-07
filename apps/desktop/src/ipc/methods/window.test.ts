import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import { getLocalEnvironmentBootstraps, getWindowFullscreenState, setTheme } from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyWslConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("publishes the concrete running distro without replacing the stable instance id", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance]))),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(Option.some(retryingConfig)),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(
        Option.some({
          ...readyWslConfig,
          preflightFailure: Option.some({
            reason: "WSL probe timed out",
            fatal: false,
            retryLimit: 12,
          }),
        }),
      ),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([stoppedInstance])));
  });
});

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeed(Option.some(window)),
        }),
      ),
    );
  });
});

describe("setTheme", () => {
  it.effect("accepts the palette extension while preserving legacy callers", () => {
    const sources: string[] = [];
    const palettes: Array<unknown> = [];
    const themeSources: string[] = [];
    let syncCount = 0;
    const palette = {
      appearance: "dark" as const,
      background: "#1f1a24",
      foreground: "#f9f8fb",
      accent: "#a3004c",
      titlebarSymbol: "#f9f8fb",
    };

    return Effect.gen(function* () {
      yield* setTheme.handler({ theme: "dark", palette });
      yield* setTheme.handler("light");

      assert.deepEqual(sources, ["dark", "light"]);
      assert.deepEqual(palettes, [palette]);
      assert.deepEqual(themeSources, ["dark", "light"]);
      assert.equal(syncCount, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ElectronTheme.ElectronTheme)({
            setSource: (theme) =>
              Effect.sync(() => {
                sources.push(theme);
              }),
          }),
          Layer.mock(DesktopAppSettings.DesktopAppSettings)({
            setThemePalette: (nextPalette) =>
              Effect.sync(() => {
                palettes.push(nextPalette);
                return {
                  settings: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  changed: true,
                };
              }),
            setThemeSource: (nextTheme) =>
              Effect.sync(() => {
                themeSources.push(nextTheme);
                return {
                  settings: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  changed: true,
                };
              }),
          }),
          Layer.mock(DesktopWindow.DesktopWindow)({
            syncAppearance: () =>
              Effect.sync(() => {
                syncCount += 1;
              }),
          }),
        ),
      ),
    );
  });

  it.effect("keeps live theme application ahead of best-effort persistence", () => {
    const events: string[] = [];
    const palette = {
      appearance: "dark" as const,
      background: "#1f1a24",
      foreground: "#f9f8fb",
      accent: "#a3004c",
    };
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/desktop-settings.json",
      cause: new Error("read-only settings directory"),
    });

    return Effect.gen(function* () {
      yield* setTheme.handler({ theme: "dark", palette });

      assert.deepEqual(events, ["set-source", "sync:#1f1a24", "persist-palette", "persist-source"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ElectronTheme.ElectronTheme)({
            setSource: () =>
              Effect.sync(() => {
                events.push("set-source");
              }),
          }),
          Layer.mock(DesktopAppSettings.DesktopAppSettings)({
            setThemePalette: () =>
              Effect.sync(() => {
                events.push("persist-palette");
              }).pipe(Effect.andThen(Effect.fail(settingsFailure))),
            setThemeSource: () =>
              Effect.sync(() => {
                events.push("persist-source");
              }).pipe(Effect.andThen(Effect.fail(settingsFailure))),
          }),
          Layer.mock(DesktopWindow.DesktopWindow)({
            syncAppearance: (nextPalette) =>
              Effect.sync(() => {
                events.push(`sync:${nextPalette?.background ?? "missing"}`);
              }),
          }),
        ),
      ),
    );
  });
});
