import { desktopWindowBoundsEquivalence, environmentInput, layerDesktopAssets, layerDesktopClientSettings, layerDesktopEnvironment, layerDesktopServerExposure, layerElectronApp, layerElectronMenu, layerElectronTheme, layerTest, makeSplashScenario } from "./DesktopWindow.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import { DesktopSnapShotId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Electron from "electron";
import { vi } from "vite-plus/test";
vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]),
  },
}));
import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { SNAP_SHOT_EVENT_CHANNEL } from "../ipc/channels.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";

function makeFakeBrowserWindow() {
  const windowListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  let zoomLevel = 0;
  const webContents = {
    copyImageAt: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => "t3code-dev://app/"),
    getZoomLevel: vi.fn(() => zoomLevel),
    getZoomFactor: vi.fn(() => 1.2 ** zoomLevel),
    setZoomLevel: vi.fn((level: number) => {
      zoomLevel = level;
    }),
    isLoadingMainFrame: vi.fn(() => false),
    navigationHistory: {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => true),
      goBack: vi.fn(),
      goForward: vi.fn(),
    },
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(eventName, listener);
    }),
    once: vi.fn<(eventName: string, listener: (...args: readonly unknown[]) => void) => void>(),
    openDevTools: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    replaceMisspelling: vi.fn(),
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    toggleDevTools: vi.fn(),
  };

  const window = {
    close: vi.fn(),
    focus: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    loadURL: vi.fn(() => Promise.resolve()),
    maximize: vi.fn(),
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    once: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    restore: vi.fn(),
    setBackgroundColor: vi.fn(),
    setAutoHideCursor: vi.fn(),
    setFullScreen: vi.fn(),
    setOpacity: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    show: vi.fn(),
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    getBounds: window.getBounds,
    getNormalBounds: window.getNormalBounds,
    isDestroyed: window.isDestroyed,
    isFullScreen: window.isFullScreen,
    isMaximized: window.isMaximized,
    isMinimized: window.isMinimized,
    loadURL: window.loadURL,
    maximize: window.maximize,
    openDevTools: webContents.openDevTools,
    reload: webContents.reload,
    reloadIgnoringCache: webContents.reloadIgnoringCache,
    toggleDevTools: webContents.toggleDevTools,
    navigationHistory: webContents.navigationHistory,
    send: webContents.send,
    setZoomLevel: webContents.setZoomLevel,
    setWindowButtonPosition: window.setWindowButtonPosition,
    setBackgroundThrottling: webContents.setBackgroundThrottling,
    setAutoHideCursor: window.setAutoHideCursor,
    setFullScreen: window.setFullScreen,
    setOpacity: window.setOpacity,
    webContentsListeners,
    webContentsOnce: webContents.once,
    windowListeners,
  };
}

const captureOne = DesktopSnapShotId.make("11111111-1111-4111-8111-111111111111");

const captureTwo = DesktopSnapShotId.make("22222222-2222-4222-8222-222222222222");

describe("DesktopWindow", () => {
  it.effect("maps macOS horizontal swipes to available history navigation", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const swipe = fakeWindow.windowListeners.get("swipe");
        assert.isDefined(swipe);
        if (!swipe) return;
        const history = fakeWindow.navigationHistory;

        swipe({}, "left");
        assert.equal(history.goBack.mock.calls.length, 1);
        assert.equal(history.goForward.mock.calls.length, 0);
        swipe({}, "right");
        assert.equal(history.goForward.mock.calls.length, 1);

        swipe({}, "up");
        swipe({}, "down");
        history.canGoBack.mockReturnValue(false);
        history.canGoForward.mockReturnValue(false);
        swipe({}, "left");
        swipe({}, "right");
        assert.equal(history.goBack.mock.calls.length, 1);
        assert.equal(history.goForward.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists the current main window bounds before the window closes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 240, y: 160, width: 1410, height: 930 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const writeStarted = yield* Deferred.make<void>();
      const allowWrite = yield* Deferred.make<void>();
      const flushCompleted = yield* Deferred.make<void>();
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        beforeMainWindowBoundsUpdate: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowWrite)),
            Effect.asVoid,
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Deferred.await(writeStarted);
        fakeWindow.isDestroyed.mockReturnValue(true);

        const flushFiber = yield* desktopWindow.flushMainWindowBounds.pipe(
          Effect.andThen(Deferred.succeed(flushCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(flushCompleted));

        yield* Deferred.succeed(allowWrite, undefined);
        yield* Fiber.join(flushFiber);
        assert.isTrue(yield* Deferred.isDone(flushCompleted));

        assert.deepEqual(mainWindowBoundsUpdates, [
          {
            x: 240,
            y: 160,
            width: 1410,
            height: 930,
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens safe off-origin renderer navigations in the system browser", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willNavigate = fakeWindow.webContentsListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("will-navigate listener was not registered");
        }
        for (const [url, expectedPrevented] of [
          ["t3code-dev://app/threads?id=1#latest", false],
          ["t3code-dev://other/", true],
          ["t3code://app/", true],
        ] as const) {
          const preventDefault = vi.fn();
          willNavigate({ preventDefault }, url);
          assert.equal(preventDefault.mock.calls.length, expectedPrevented ? 1 : 0, url);
        }
        assert.deepEqual(openedExternalUrls, []);

        let prevented = false;
        willNavigate(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "https://accounts.microsoft.com/oauth",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(openedExternalUrls, ["https://accounts.microsoft.com/oauth"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "retries opening the real main on activate when a failed post-readiness open left only the splash",
    () =>
      Effect.gen(function* () {
        const splash = makeFakeBrowserWindow();
        const main = makeFakeBrowserWindow();
        const scenario = yield* makeSplashScenario([splash.window, null, main.window]);

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;

          yield* desktopWindow.showConnectingSplash;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);

          const readyExit = yield* Effect.exit(
            desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773")),
          );
          assert.equal(readyExit._tag, "Failure");
          assert.equal(yield* Ref.get(scenario.createCalls), 2);
          assert.isTrue(Option.isNone(yield* Ref.get(scenario.mainWindow)));

          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(scenario.createCalls), 3);
          const registeredMain = yield* Ref.get(scenario.mainWindow);
          assert.isTrue(Option.isSome(registeredMain));
          assert.equal(Option.getOrThrow(registeredMain), main.window);
        }).pipe(Effect.provide(scenario.layer));
      }),
  );

  it.effect("delivers capture completion and late errors without taking focus back", () =>
    Effect.gen(function* () {
      const operations: Array<string> = [];
      let foreground = "Discord";
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.send.mockImplementation(() => {
        operations.push("send");
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        onReveal: () => {
          foreground = "T3 Code";
          operations.push("reveal");
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        fakeWindow.windowListeners.get("ready-to-show")?.();
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        operations.length = 0;
        foreground = "Discord";
        yield* desktopWindow.dispatchSnapShotEvent({ type: "started", id: captureOne });
        assert.equal(foreground, "T3 Code");
        foreground = "Explorer";
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });
        yield* desktopWindow.dispatchSnapShotEvent({ type: "failed", id: captureTwo });

        assert.equal(foreground, "Explorer");
        assert.deepEqual(operations, ["send", "reveal", "send", "send"]);
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [SNAP_SHOT_EVENT_CHANNEL, { type: "started", id: captureOne }],
          [SNAP_SHOT_EVENT_CHANNEL, { type: "ready", id: captureOne }],
          [SNAP_SHOT_EVENT_CHANNEL, { type: "failed", id: captureTwo }],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not reopen a closed main window for a completed capture", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const onReveal = vi.fn();
      const layer = layerTest({ window: fakeWindow.window, createCount, mainWindow, onReveal });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        fakeWindow.isDestroyed.mockReturnValue(true);
        yield* Ref.set(mainWindow, Option.none());
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });

        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(fakeWindow.send.mock.calls.length, 0);
        assert.equal(onReveal.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
