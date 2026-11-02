import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ManagedPolicyLimits } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ManagedPolicyFileError } from "@t3tools/shared/managedPolicyFile";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Electron from "electron";
import { vi } from "vite-plus/test";
import type * as Electron from "electron";

const { focusedWebContents, ownerWindow } = vi.hoisted(() => ({
  focusedWebContents: vi.fn(),
  ownerWindow: vi.fn(),
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: focusedWebContents },
  BrowserWindow: { fromWebContents: ownerWindow, getAllWindows: vi.fn(() => []) },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));

import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  getLocalEnvironmentBootstraps,
  installRelayTelemetryEnabled,
  getLocalEnvironmentBearerToken,
  installLocalEnvironmentBootstrapEvents,
  pickProjectFavicon,
  probeRemoteEditors,
  readMedia,
  syncHtmlFullscreen,
} from "./window.ts";

it.effect.each(["ready before request", "ready after request", "restart before ready"])(
  "exchanges a renderer's bearer token with %s",
  (ordering) =>
    Effect.gen(function* () {
      const primaryBackendStartup = yield* SubscriptionRef.make<DesktopState.PrimaryBackendStartup>(
        {
          _tag: "Starting",
        },
      );
      const exchanges = yield* Ref.make(0);
      const backendReady = yield* Ref.make(false);
      const quitting = yield* Ref.make(false);
      const request = getLocalEnvironmentBearerToken.handler(undefined).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopState.DesktopState, {
              primaryBackendStartup,
              backendReady,
              quitting,
            }),
            Layer.succeed(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
              getBearerToken: Ref.update(exchanges, (count) => count + 1).pipe(Effect.as("bearer")),
            }),
          ),
        ),
      );
      if (ordering === "ready before request") {
        yield* SubscriptionRef.set(primaryBackendStartup, { _tag: "Ready" });
      }
      const fiber = yield* request.pipe(Effect.forkChild({ startImmediately: true }));
      if (ordering !== "ready before request") {
        assert.equal(yield* Ref.get(exchanges), 0);
        if (ordering === "restart before ready") {
          yield* SubscriptionRef.set(primaryBackendStartup, {
            _tag: "Failing",
            reason: "backend restarting",
            output: "process exited",
          });
          assert.equal(yield* Ref.get(exchanges), 0);
        }
        yield* SubscriptionRef.set(primaryBackendStartup, { _tag: "Ready" });
      }
      assert.equal(yield* Fiber.join(fiber), "bearer");
      assert.equal(yield* Ref.get(exchanges), 1);
    }),
);

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

describe("syncHtmlFullscreen", () => {
  const fullscreenWindow = (fullscreen: boolean, { animatedExit = false } = {}) => {
    let current = fullscreen;
    let exiting = false;
    const queued: boolean[] = [];
    const leaveListeners: Array<() => void> = [];
    const leave = () => {
      current = false;
      for (const listener of leaveListeners) listener();
    };
    // Like macOS, an animated exit keeps reporting fullscreen and queues requests until it ends.
    const setFullScreen = vi.fn((next: boolean) => {
      if (exiting) queued.push(next);
      else if (next) current = true;
      else if (!current) return;
      else if (animatedExit) exiting = true;
      else leave();
    });
    const finishExit = () => {
      exiting = false;
      leave();
      for (const next of queued.splice(0)) setFullScreen(next);
    };
    const window = {
      webContents: { id: 1 },
      isDestroyed: () => false,
      isFullScreen: () => current,
      setFullScreen,
      on: (event: string, listener: () => void) => {
        if (event === "leave-full-screen") leaveListeners.push(listener);
      },
    } as unknown as Electron.BrowserWindow;
    const layer = Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(window) });
    return { window, setFullScreen, finishExit, layer };
  };
  const fromMainRenderer = { sender: { id: 1 } };

  it.effect("takes the screen for the app's own fullscreen element and gives it back", () => {
    const { window, layer } = fullscreenWindow(false);
    return Effect.gen(function* () {
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      assert.isTrue(window.isFullScreen());

      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);
      assert.isFalse(window.isFullScreen());
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a window the user had already made fullscreen", () => {
    const { window, setFullScreen, layer } = fullscreenWindow(true);
    return Effect.gen(function* () {
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);

      assert.isTrue(window.isFullScreen());
      assert.strictEqual(setFullScreen.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("hands the window back once the user leaves OS fullscreen during playback", () => {
    const { window, layer } = fullscreenWindow(false);
    return Effect.gen(function* () {
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      window.setFullScreen(false);
      window.setFullScreen(true);
      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);

      assert.isTrue(window.isFullScreen());
    }).pipe(Effect.provide(layer));
  });

  it.effect("takes the screen again when the video returns during an animated exit", () => {
    const { window, finishExit, layer } = fullscreenWindow(false, { animatedExit: true });
    return Effect.gen(function* () {
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      finishExit();
      assert.isTrue(window.isFullScreen());

      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);
      finishExit();
      assert.isFalse(window.isFullScreen());
    }).pipe(Effect.provide(layer));
  });
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

describe("local environment bootstrap events", () => {
  it.effect("forwards topology changes and resume, and disposes the resume listener", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 });
      const sent = yield* Queue.unbounded<string>();
      const send = vi.fn();
      vi.mocked(Electron.BrowserWindow.getAllWindows).mockReturnValue([
        { isDestroyed: () => false, webContents: { send } } as unknown as Electron.BrowserWindow,
      ]);
      vi.mocked(Electron.powerMonitor.on).mockClear();
      vi.mocked(Electron.powerMonitor.removeListener).mockClear();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installLocalEnvironmentBootstrapEvents().pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(DesktopBackendPool.DesktopBackendPool)({
                  changes: Stream.fromPubSub(changes),
                }),
                Layer.mock(ElectronWindow.ElectronWindow)({
                  sendAll: (channel) => Queue.offer(sent, channel).pipe(Effect.asVoid),
                }),
              ),
            ),
          );
          yield* PubSub.publish(changes, undefined);
          assert.equal(yield* Queue.take(sent), "desktop:local-environment-bootstraps-changed");
          const [event, resume] = vi.mocked(Electron.powerMonitor.on).mock.calls.at(-1)!;
          assert.equal(event, "resume");
          resume();
          assert.deepEqual(send.mock.calls, [["desktop:local-environment-bootstraps-changed"]]);
        }),
      );
      assert.equal(
        vi.mocked(Electron.powerMonitor.removeListener).mock.calls.at(-1)?.[0],
        "resume",
      );
      vi.mocked(Electron.BrowserWindow.getAllWindows).mockReturnValue([]);
    }),
  );
});
