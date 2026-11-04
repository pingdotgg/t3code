import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ManagedPolicyLimits } from "@t3tools/contracts";
import { EDITORS, REMOTE_CAPABLE_EDITOR_IDS } from "@t3tools/contracts";
import { resolveEditorCommand } from "@t3tools/shared/editor";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ManagedPolicyFileError } from "@t3tools/shared/managedPolicyFile";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";
import type * as Electron from "electron";

const { focusedWebContents, ownerWindow } = vi.hoisted(() => ({
  focusedWebContents: vi.fn(),
  ownerWindow: vi.fn(),
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: focusedWebContents },
  BrowserWindow: { fromWebContents: ownerWindow },
}));

import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  getLocalEnvironmentBootstraps,
  installRelayTelemetryEnabled,
  pickProjectFavicon,
  probeRemoteEditors,
  readMedia,
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
  currentConfig: Effect.succeedSome(readyWslConfig),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

const backendConfigurationLayer = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
    currentBootstrapToken: Effect.succeed("current-window-token"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const bootstrapsLayer = (instances: ReadonlyArray<DesktopBackendManager.DesktopBackendInstance>) =>
  Layer.merge(DesktopBackendPool.layerTest([...instances]), backendConfigurationLayer);

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("hands out the current window's token to a backend launched with the secret", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "current-window-token",
        },
      ]);
    }).pipe(
      Effect.provide(
        bootstrapsLayer([
          {
            ...defaultWslInstance,
            currentConfig: Effect.succeedSome({
              ...readyWslConfig,
              bootstrap: {
                ...readyWslConfig.bootstrap,
                desktopBootstrapSecret: "desktop-secret",
              },
            }),
          },
        ]),
      ),
    ),
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
      currentConfig: Effect.succeedSome(retryingConfig),
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
    }).pipe(Effect.provide(bootstrapsLayer([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome({
        ...readyWslConfig,
        preflightFailure: Option.some({
          reason: "WSL probe timed out",
          fatal: false,
          retryLimit: 12,
        }),
      }),
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
    }).pipe(Effect.provide(bootstrapsLayer([stoppedInstance])));
  });
});

describe("installRelayTelemetryEnabled", () => {
  // The renderer reads this over sync IPC, so the answer must not wait on the filesystem.
  const relayTelemetryEnabled = (
    env: NodeJS.ProcessEnv,
    policy?: Parameters<typeof DesktopManagedPolicy.layerTest>[0],
  ) =>
    Effect.gen(function* () {
      const listeners = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
      const ipcMain: DesktopIpc.DesktopIpcMain = {
        removeHandler: () => undefined,
        handle: () => undefined,
        removeAllListeners: (channel) => void listeners.delete(channel),
        on: (channel, listener) => void listeners.set(channel, listener),
      };
      yield* installRelayTelemetryEnabled().pipe(
        Effect.provideService(HostProcess.Environment, env),
        Effect.provide(
          Layer.mergeAll(DesktopIpc.layer(ipcMain), DesktopManagedPolicy.layerTest(policy)),
        ),
      );
      const event = { returnValue: undefined as unknown };
      listeners.get(IpcChannels.GET_RELAY_TELEMETRY_ENABLED_CHANNEL)?.(event as never);
      return event.returnValue;
    }).pipe(Effect.scoped);

  it.effect("reads the desktop host opt-out before returning the renderer policy", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* relayTelemetryEnabled({ T3CODE_TELEMETRY_ENABLED: "false" }));
      assert.isTrue(yield* relayTelemetryEnabled({}));
    }),
  );

  it.effect("turns relay tracing off when the managed policy turns telemetry off", () =>
    Effect.gen(function* () {
      const policy = (limits: ManagedPolicyLimits) => ({
        schemaVersion: 1 as const,
        organization: "Example Corp",
        limits,
      });
      assert.isFalse(yield* relayTelemetryEnabled({}, policy({ telemetry: false })));
      assert.isTrue(yield* relayTelemetryEnabled({}, policy({ webhookTasks: false })));
      // A policy that cannot be read fails closed.
      assert.isFalse(
        yield* relayTelemetryEnabled(
          {},
          new ManagedPolicyFileError({ path: "/test", reason: "bad JSON" }),
        ),
      );
    }),
  );
});

describe("readMedia", () => {
  it.effect("reads http(s) media only for the main window", () =>
    Effect.gen(function* () {
      const mib = new Uint8Array(1024 * 1024);
      const fetch = vi.fn(async (url: string) => {
        if (url.endsWith("/missing.png")) return new Response("Not Found", { status: 404 });
        if (url.endsWith("/small.png")) return new Response(new Uint8Array([1, 2]));
        let sent = 0;
        // 257 MiB from one reused chunk: over the cap without allocating it.
        const huge = new ReadableStream<Uint8Array>({
          pull: (controller) => (sent++ < 257 ? controller.enqueue(mib) : controller.close()),
        });
        return new Response(huge);
      });
      const main = {
        webContents: { id: 1, session: { fetch } },
      } as unknown as Electron.BrowserWindow;
      const read = (url: string, senderId: number) =>
        readMedia
          .handler(url, { sender: { id: senderId } })
          .pipe(
            Effect.provide(
              Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(main) }),
            ),
          );

      assert.strictEqual(yield* read("https://example.com/a.png", 2), null);
      assert.strictEqual(yield* read("file:///etc/passwd", 1), null);
      assert.strictEqual(fetch.mock.calls.length, 0);
      assert.deepEqual(yield* read("https://example.com/small.png", 1), {
        status: 200,
        mimeType: "",
        data: Buffer.from([1, 2]),
      });
      assert.deepEqual(yield* read("https://example.com/missing.png", 1), {
        status: 404,
        mimeType: "text/plain;charset=UTF-8",
        data: new Uint8Array(),
      });
      assert.deepEqual(yield* read("https://example.com/huge.mp4", 1), {
        status: 413,
        mimeType: "",
        data: new Uint8Array(),
      });
    }),
  );
});

describe("pickProjectFavicon", () => {
  const pickerLayer = (
    pickFiles: () => Effect.Effect<Array<string>>,
    settings?: DesktopAppSettings.DesktopSettings,
  ) =>
    Layer.mergeAll(
      Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
      Layer.mock(ElectronWindow.ElectronWindow)({
        focusedMainOrFirst: Effect.succeedNone,
      }),
      DesktopAppSettings.layerTest(settings),
    );

  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon
        .handler("/project")
        .pipe(Effect.provide(pickerLayer(pickFiles)));

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
                extensions: [
                  "avif",
                  "bmp",
                  "gif",
                  "ico",
                  "heic",
                  "heif",
                  "jpeg",
                  "jpg",
                  "png",
                  "svg",
                  "tif",
                  "tiff",
                  "webp",
                  "icns",
                ],
              },
            ],
          },
        ],
      ]);
    }),
  );

  it.effect("does not open a picker while the local environment is off", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          pickerLayer(pickFiles, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          }),
        ),
      );

      assert.strictEqual(result, null);
      assert.strictEqual(pickFiles.mock.calls.length, 0);
    }),
  );
});

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "finds remote editors installed without PATH launchers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-editors-" });
      for (const app of ["Cursor", "Visual Studio Code", "WebStorm"]) {
        const executable = path.join(
          home,
          "Applications",
          `${app}.app`,
          app === "WebStorm" ? "Contents/MacOS/webstorm" : "Contents/Resources/app/bin/code",
        );
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
      }
      const editors = yield* probeRemoteEditors.handler(undefined).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          PATH: path.join(home, "empty"),
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.include(editors, "cursor");
      assert.include(editors, "vscode");
      assert.include(editors, "webstorm");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

describe("probeRemoteEditors PATH scan", () => {
  const platform = HostProcess.Platform.defaultValue();
  const launcherName = (command: string) => (platform === "win32" ? `${command}.cmd` : command);

  const makeFakePath = Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-probe-path-" });
    const dirs = ["a", "b", "c", "d"].map((name) => path.join(root, name));
    for (const dir of dirs) yield* fs.makeDirectory(dir, { recursive: true });
    // Launchers in different PATH directories, deliberately not in REMOTE_CAPABLE_EDITOR_IDS order.
    for (const [dir, command] of [
      [dirs[2]!, "webstorm"],
      [dirs[0]!, "cursor"],
      [dirs[3]!, "code"],
      [dirs[1]!, "zed"],
    ] as const) {
      const file = path.join(dir, launcherName(command));
      yield* fs.writeFileString(file, "#!/bin/sh\n");
      if (platform !== "win32") yield* fs.chmod(file, 0o755);
    }
    return {
      root,
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: dirs.join(platform === "win32" ? ";" : ":"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
    };
  });

  const countingFileSystem = (counter: { stat: number; reads: Map<string, number> }) =>
    Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return FileSystem.FileSystem.of({
          ...fs,
          stat: (target) => {
            counter.stat += 1;
            return fs.stat(target);
          },
          readDirectory: (target, options) => {
            counter.reads.set(target, (counter.reads.get(target) ?? 0) + 1);
            return fs.readDirectory(target, options);
          },
        });
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer));

  const serialReference = (env: Record<string, string>) =>
    Effect.gen(function* () {
      const available: Array<string> = [];
      for (const editorId of REMOTE_CAPABLE_EDITOR_IDS) {
        const editor = EDITORS.find((candidate) => candidate.id === editorId);
        if (editor && Option.isSome(yield* resolveEditorCommand(editor, env))) {
          available.push(editorId);
        }
      }
      return available;
    });

  it.effect("returns the same editors in the same order as a serial uncached scan", () =>
    Effect.gen(function* () {
      const { env } = yield* makeFakePath();
      const reference = yield* serialReference(env);
      // A different PATH string keeps the 30 s command-resolution cache from sharing results.
      const probed = yield* probeRemoteEditors.handler(undefined).pipe(
        Effect.provideService(HostProcess.Environment, {
          ...env,
          PATH: `${env.PATH}${platform === "win32" ? ";" : ":"}${env.HOME}`,
        }),
        Effect.provideService(HostProcess.Platform, platform),
      );
      // The host can add editors from app folders the fixture can't redirect (e.g. /Applications on macOS),
      // so pin only the fixture's editors; the parity check below still compares everything.
      const fixtureEditors = ["cursor", "vscode", "zed", "webstorm"];
      assert.deepStrictEqual(
        reference.filter((id) => fixtureEditors.includes(id)),
        fixtureEditors,
      );
      assert.deepStrictEqual(probed, reference);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads each PATH directory once instead of stat-ing every candidate per editor", () =>
    Effect.gen(function* () {
      const { env: baseEnv } = yield* makeFakePath();
      const delimiter = platform === "win32" ? ";" : ":";
      const uncachedCounter = { stat: 0, reads: new Map<string, number>() };
      const cachedCounter = { stat: 0, reads: new Map<string, number>() };
      const uncachedEnv = { ...baseEnv, PATH: `${baseEnv.PATH}${delimiter}${baseEnv.HOME}x1` };
      const cachedEnv = { ...baseEnv, PATH: `${baseEnv.PATH}${delimiter}${baseEnv.HOME}x2` };
      const uncached = yield* serialReference(uncachedEnv).pipe(
        Effect.provide(countingFileSystem(uncachedCounter)),
      );
      const cached = yield* probeRemoteEditors
        .handler(undefined)
        .pipe(
          Effect.provideService(HostProcess.Environment, cachedEnv),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provide(countingFileSystem(cachedCounter)),
        );
      assert.deepStrictEqual(cached, uncached);
      assert.isAbove(uncachedCounter.stat, 0);
      // On every platform the probe lists each PATH directory at most once. Only PATH entries count:
      // resolveEditorCommand also reads app folders such as /Applications on macOS.
      const pathReads = cachedEnv.PATH.split(delimiter)
        .filter((entry) => entry.length > 0)
        .map((entry) => cachedCounter.reads.get(entry) ?? 0);
      assert.isAbove(Math.max(...pathReads), 0);
      assert.isAtMost(Math.max(...pathReads), 1);
      // Without the listings, Windows stats every PATH entry x PATHEXT candidate for each editor;
      // elsewhere there is no PATHEXT, so the stat count is about the same either way.
      if (platform === "win32") {
        assert.isBelow(cachedCounter.stat, uncachedCounter.stat / 2);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
