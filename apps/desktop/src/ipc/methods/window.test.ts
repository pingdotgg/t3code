import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  getLocalEnvironmentBootstraps,
  getWindowFullscreenState,
  pickProjectFavicon,
  pickThemeFiles,
} from "./window.ts";

function fileInfo(size: number): FileSystem.File.Info {
  return {
    type: "File",
    mtime: Option.none(),
    atime: Option.none(),
    birthtime: Option.none(),
    dev: 0,
    ino: Option.none(),
    mode: 0,
    nlink: Option.none(),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    size: FileSystem.Size(size),
    blksize: Option.none(),
    blocks: Option.none(),
  };
}

function testFile(readAlloc: FileSystem.File["readAlloc"]): FileSystem.File {
  return {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: Effect.succeed(fileInfo(0)),
    seek: () => Effect.void,
    sync: Effect.void,
    read: () => Effect.succeed(FileSystem.Size(0)),
    readAlloc,
    truncate: () => Effect.void,
    write: () => Effect.succeed(FileSystem.Size(0)),
    writeAll: () => Effect.void,
  };
}

function pickThemeFilesLayer({
  fileSize,
  readAlloc,
}: {
  fileSize: number;
  readAlloc: FileSystem.File["readAlloc"];
}) {
  return Layer.mergeAll(
    Layer.mock(ElectronDialog.ElectronDialog)({
      pickFiles: () => Effect.succeed(["/themes/aurora.vsix"]),
    }),
    Layer.mock(ElectronWindow.ElectronWindow)({
      focusedMainOrFirst: Effect.succeed(Option.none()),
    }),
    FileSystem.layerNoop({
      exists: () => Effect.succeed(false),
      stat: () => Effect.succeed(fileInfo(fileSize)),
      open: () => Effect.succeed(testFile(readAlloc)),
    }),
    NodePath.layer,
  );
}

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

describe("pickProjectFavicon", () => {
  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeed(Option.none()),
            }),
          ),
        ),
      );

      assert.strictEqual(result, "/pictures/icon.png");
      assert.deepEqual(pickFiles.mock.calls, [
        [
          {
            owner: Option.none(),
            defaultPath: Option.some("/project"),
            multiple: false,
            filters: [
              {
                name: "Images",
                extensions: ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"],
              },
            ],
          },
        ],
      ]);
    }),
  );
});

describe("pickThemeFiles", () => {
  it.effect("returns a base64-encoded extension package without text", () => {
    const bytes = new TextEncoder().encode("theme package");
    let readCount = 0;

    return Effect.gen(function* () {
      const result = yield* pickThemeFiles.handler(undefined);

      assert.deepEqual(result, [
        {
          name: "aurora.vsix",
          size: bytes.byteLength,
          text: "",
          contentBase64: Buffer.from(bytes).toString("base64"),
        },
      ]);
    }).pipe(
      Effect.provide(
        pickThemeFilesLayer({
          fileSize: bytes.byteLength,
          readAlloc: () => Effect.succeed(readCount++ === 0 ? Option.some(bytes) : Option.none()),
        }),
      ),
    );
  });

  it.effect("reports a package that grows past the read cap as oversized", () =>
    Effect.gen(function* () {
      const result = yield* pickThemeFiles.handler(undefined);

      assert.deepEqual(result, [
        {
          name: "aurora.vsix",
          size: 20 * 1024 * 1024 + 1,
          text: "",
        },
      ]);
    }).pipe(
      Effect.provide(
        pickThemeFilesLayer({
          fileSize: 1,
          readAlloc: () => Effect.succeed(Option.some(new Uint8Array(64 * 1024))),
        }),
      ),
    ),
  );
});
