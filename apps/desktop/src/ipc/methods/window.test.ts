import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import {
  getLocalEnvironmentBootstraps,
  getWindowFullscreenState,
  resolveWslPickerDistro,
  resolveWslPickerSelection,
} from "./window.ts";

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
    probeReady: () => Effect.succeed(true),
};

const primaryWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  ...defaultWslInstance,
  id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("WSL (Ubuntu)"),
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

describe("WSL picker distro identity", () => {
  it.effect("pins wsl:default to the distro already running in the target instance", () =>
    Effect.gen(function* () {
      const distro = yield* resolveWslPickerDistro({
        targetEnvironmentId: "wsl:default",
        configuredDistro: null,
        wslOnly: false,
      });
      assert.equal(distro, "Ubuntu");
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance]))),
  );

  it.effect("uses the concrete primary distro for a WSL-only synthetic picker target", () =>
    Effect.gen(function* () {
      const distro = yield* resolveWslPickerDistro({
        targetEnvironmentId: "wsl:default",
        configuredDistro: null,
        wslOnly: true,
      });
      assert.equal(distro, "Ubuntu");
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([primaryWslInstance]))),
  );
});

describe("WSL picker selection safety", () => {
  it.effect("accepts a UNC path only when it belongs to the target distro", () =>
    Effect.gen(function* () {
      const result = yield* resolveWslPickerSelection({
        selectedPath: "\\\\wsl.localhost\\ubuntu\\home\\alice\\repo",
        targetDistro: "Ubuntu",
      });
      assert.deepEqual(result, { _tag: "Success", linuxPath: "/home/alice/repo" });
    }).pipe(Effect.provide(DesktopWslEnvironment.layerTest())),
  );

  it.effect("rejects a UNC path owned by another distro", () =>
    Effect.gen(function* () {
      const result = yield* resolveWslPickerSelection({
        selectedPath: "\\\\wsl.localhost\\Debian\\home\\alice\\repo",
        targetDistro: "Ubuntu",
      });
      assert.deepEqual(result, {
        _tag: "CrossDistro",
        selectedDistro: "Debian",
        targetDistro: "Ubuntu",
      });
    }).pipe(Effect.provide(DesktopWslEnvironment.layerTest())),
  );

  it.effect("fails closed when a Windows path cannot be converted", () =>
    Effect.gen(function* () {
      const result = yield* resolveWslPickerSelection({
        selectedPath: "C:\\Users\\Alice\\repo",
        targetDistro: "Ubuntu",
      });
      assert.deepEqual(result, { _tag: "ConversionFailed", targetDistro: "Ubuntu" });
    }).pipe(
      Effect.provide(
        DesktopWslEnvironment.layerTest({
          windowsToWslPath: () => Option.none(),
        }),
      ),
    ),
  );

  it.effect("converts Windows paths inside the concrete target distro", () => {
    const calls: Array<readonly [string | null, string]> = [];
    return Effect.gen(function* () {
      const result = yield* resolveWslPickerSelection({
        selectedPath: "C:\\Users\\Alice\\repo",
        targetDistro: "Ubuntu",
      });
      assert.deepEqual(result, { _tag: "Success", linuxPath: "/mnt/c/Users/Alice/repo" });
      assert.deepEqual(calls, [["Ubuntu", "C:\\Users\\Alice\\repo"]]);
    }).pipe(
      Effect.provide(
        DesktopWslEnvironment.layerTest({
          windowsToWslPath: (distro, windowsPath) => {
            calls.push([distro, windowsPath]);
            return Option.some("/mnt/c/Users/Alice/repo");
          },
        }),
      ),
    );
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
