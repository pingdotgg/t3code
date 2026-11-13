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
  it("restores bounds only when the window fits within a connected display", () => {
    const persistedBounds = { x: 2040, y: 80, width: 1320, height: 880 };
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];

    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, displays),
      persistedBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, [displays[0]!]),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });

  it("rejects renderer navigations whose origin only serializes as null", () => {
    for (const applicationUrl of ["t3code://app/", "t3code-dev://app/"]) {
      assert.isTrue(
        DesktopWindow.isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: `${applicationUrl}threads?id=1#latest`,
        }),
        applicationUrl,
      );
    }
    for (const navigationUrl of [
      "t3code://other/",
      "t3code://app.example/",
      "t3code://app:8080/",
      "t3code://user@other/",
      "t3code:app",
      "t3code-dev://app/",
      "file:///etc/passwd",
      "data:text/html,<p>hi</p>",
      "javascript:alert(1)",
      "about:blank",
      "blob:t3code://app/0b5e2c4a",
    ]) {
      assert.isFalse(
        DesktopWindow.isSameOriginRendererNavigation({
          applicationUrl: "t3code://app/",
          navigationUrl,
        }),
        navigationUrl,
      );
    }
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "data:text/html,app",
        navigationUrl: "data:text/html,other",
      }),
    );
  });

  it.effect(
    "opens and reopens the window without backend readiness when local execution is disabled",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const layer = layerTest({
          window: fakeWindow.window,
          createCount,
          mainWindow,
          createdWindowOptions: [],
          desktopSettings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          },
        });
        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.createMainIfBackendReady;
          assert.equal(yield* Ref.get(createCount), 1);
          yield* Ref.set(mainWindow, Option.none());
          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(createCount), 2);
          yield* Ref.set(mainWindow, Option.none());
          yield* desktopWindow.dispatchMenuAction("new-thread");
          assert.equal(yield* Ref.get(createCount), 3);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect.each(["before", "after"] as const)(
    "keeps a closed startup window closed until activation %s backend readiness",
    (activation) =>
      Effect.gen(function* () {
        const fake = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        yield* Effect.gen(function* () {
          const windows = yield* DesktopWindow.DesktopWindow;
          yield* windows.ensureMain;
          fake.windowListeners.get("ready-to-show")?.();
          fake.isDestroyed.mockReturnValue(true);
          fake.windowListeners.get("closed")?.();
          assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
          if (activation === "after") {
            yield* windows.handleBackendReady(new URL("http://127.0.0.1:3773"));
            assert.equal(yield* Ref.get(createCount), 1);
          }
          fake.isDestroyed.mockReturnValue(false);
          yield* windows.activate;
          assert.equal(yield* Ref.get(createCount), 2);
          yield* windows.handleBackendReady(new URL("http://127.0.0.1:3773"));
          assert.equal(yield* Ref.get(createCount), 2);
        }).pipe(Effect.provide(layerTest({ window: fake.window, createCount, mainWindow })));
      }),
  );

  it.effect.each(["renderer", "backend"] as const)(
    "reveals the painted boot shell when %s becomes ready first",
    (first) =>
      Effect.gen(function* () {
        const fake = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const reveal = vi.fn();
        const painted = Promise.withResolvers<void>();
        yield* Effect.gen(function* () {
          const windows = yield* DesktopWindow.DesktopWindow;
          yield* windows.ensureMain;
          assert.equal(fake.loadURL.mock.calls.length, 1);
          yield* windows.activate;
          yield* windows.revealOrCreateMain;
          yield* windows.dispatchMenuAction("open-settings");
          assert.equal(reveal.mock.calls.length, 0);
          if (first === "backend") {
            yield* windows.handleBackendReady(new URL("http://127.0.0.1:3773"));
            assert.equal(reveal.mock.calls.length, 0);
          }
          fake.windowListeners.get("ready-to-show")?.();
          yield* Effect.promise(() => painted.promise);
          assert.equal(reveal.mock.calls.length, 1);
          yield* windows.handleBackendReady(new URL("http://127.0.0.1:3773"));
          assert.equal(yield* Ref.get(createCount), 1);
          assert.equal(reveal.mock.calls.length, 1);
          yield* windows.handleBackendNotReady;
          yield* windows.activate;
          assert.equal(reveal.mock.calls.length, 2);
        }).pipe(
          Effect.provide(
            layerTest({
              window: fake.window,
              createCount,
              mainWindow,
              onReveal: () => {
                reveal();
                painted.resolve();
              },
            }),
          ),
        );
      }),
  );

  it.effect("blocks only repeated Cmd+W input before it reaches the native window menu", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const beforeInput = fakeWindow.webContentsListeners.get("before-input-event");
        if (!beforeInput) {
          return yield* Effect.die("before-input-event listener was not registered");
        }

        let prevented = false;
        const event = { preventDefault: () => (prevented = true) };
        const input = {
          type: "keyDown",
          isAutoRepeat: true,
          key: "W",
          meta: true,
          control: false,
          alt: false,
          shift: false,
        };
        beforeInput(event, input);
        assert.isTrue(prevented);

        prevented = false;
        beforeInput(event, { ...input, isAutoRepeat: false });
        assert.isFalse(prevented);

        prevented = false;
        beforeInput(event, { ...input, meta: false });
        assert.isFalse(prevented);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("zooms main with a focused popup and reapplies preview zoom", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const popup = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const previewZoomReapplies: number[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        previewZoomReapplies,
        focusedWindow: popup.window,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("in");
        yield* desktopWindow.zoomMain("reset");

        assert.deepEqual(
          fakeWindow.setZoomLevel.mock.calls.map(([level]) => level),
          [-0.5, -1, -0.5, 0],
        );
        assert.deepEqual(previewZoomReapplies, [-0.5, -1, -0.5, 0]);
        assert.equal(popup.setZoomLevel.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("zooms the app from Ctrl+wheel like the menu does", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const previewZoomReapplies: number[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        previewZoomReapplies,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const zoomChanged = fakeWindow.webContentsListeners.get("zoom-changed");
        if (!zoomChanged) return yield* Effect.die("zoom-changed listener was not registered");
        zoomChanged({}, "in");
        zoomChanged({}, "out");
        zoomChanged({}, "out");

        assert.deepEqual(
          fakeWindow.setZoomLevel.mock.calls.map(([level]) => level),
          [0.5, 0, -0.5],
        );
        assert.deepEqual(previewZoomReapplies, [0.5, 0, -0.5]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reloads and inspects the main window even when a popup has focus", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const popup = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        focusedWindow: popup.window,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.runMainContentsCommand("reload");
        yield* desktopWindow.runMainContentsCommand("forceReload");
        yield* desktopWindow.runMainContentsCommand("toggleDevTools");

        assert.equal(fakeWindow.reload.mock.calls.length, 1);
        assert.equal(fakeWindow.reloadIgnoringCache.mock.calls.length, 1);
        assert.equal(fakeWindow.toggleDevTools.mock.calls.length, 1);
        assert.equal(popup.reload.mock.calls.length, 0);
        assert.equal(popup.reloadIgnoringCache.mock.calls.length, 0);
        assert.equal(popup.toggleDevTools.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not open main or splash windows once quitting has started", () =>
    Effect.gen(function* () {
      const fake = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      yield* Effect.gen(function* () {
        const windows = yield* DesktopWindow.DesktopWindow;
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);

        yield* windows.showConnectingSplash;
        yield* windows.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* windows.activate;
        yield* windows.dispatchMenuAction("open-settings");
        for (const creation of [
          windows.createMain,
          windows.ensureMain,
          windows.revealOrCreateMain,
        ]) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(creation)));
        }

        assert.equal(yield* Ref.get(createCount), 0);
        assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
        assert.equal(fake.send.mock.calls.length, 0);
      }).pipe(Effect.provide(layerTest({ window: fake.window, createCount, mainWindow })));
    }),
  );

  it.effect.each(["main", "splash"] as const)(
    "destroys a %s window when quit races native creation without loading or revealing it",
    (kind) =>
      Effect.gen(function* () {
        const fake = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const creationStarted = yield* Deferred.make<void>();
        const releaseCreation = yield* Deferred.make<void>();
        const reveal = vi.fn();
        const layer = layerTest({
          window: fake.window,
          createCount,
          mainWindow,
          onWindowCreate: Deferred.succeed(creationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCreation)),
          ),
          destroyAll: Effect.sync(() => fake.isDestroyed.mockReturnValue(true)),
          onReveal: reveal,
        });

        yield* Effect.gen(function* () {
          const windows = yield* DesktopWindow.DesktopWindow;
          const state = yield* DesktopState.DesktopState;
          const fiber = yield* (
            kind === "splash"
              ? windows.showConnectingSplash
              : windows.handleBackendReady(new URL("http://127.0.0.1:3773"))
          ).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(creationStarted);
          yield* Ref.set(state.quitting, true);
          yield* Deferred.succeed(releaseCreation, undefined);
          assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
          assert.equal(yield* Ref.get(createCount), 1);
          assert.isTrue(fake.window.isDestroyed());
          assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
          assert.equal(fake.loadURL.mock.calls.length, 0);
          assert.equal(fake.openDevTools.mock.calls.length, 0);
          assert.equal(reveal.mock.calls.length, 0);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect.each(["backend ready", "activation", "renderer event"] as const)(
    "quietly cancels %s when quit races preview cleanup",
    (entry) =>
      Effect.gen(function* () {
        const fake = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const previewStarted = yield* Deferred.make<void>();
        const releasePreview = yield* Deferred.make<void>();
        const reveal = vi.fn();
        const warnings: unknown[] = [];
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn" || logLevel === "Error") warnings.push(message);
        });
        const layer = layerTest({
          window: fake.window,
          createCount,
          mainWindow,
          desktopSettings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          },
          setPreviewMainWindow: () =>
            Deferred.succeed(previewStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePreview)),
            ),
          destroyAll: Effect.sync(() => fake.isDestroyed.mockReturnValue(true)),
          onReveal: reveal,
        });

        yield* Effect.gen(function* () {
          const windows = yield* DesktopWindow.DesktopWindow;
          const state = yield* DesktopState.DesktopState;
          const creation =
            entry === "backend ready"
              ? windows.handleBackendReady(new URL("http://127.0.0.1:3773"))
              : entry === "activation"
                ? windows.activate
                : windows.dispatchMenuAction("open-settings");
          const fiber = yield* creation.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(previewStarted);
          yield* Ref.set(state.quitting, true);
          // Cover both an already-destroyed window and one shutdown has yet to destroy.
          fake.isDestroyed.mockReturnValue(entry !== "backend ready");
          yield* Deferred.succeed(releasePreview, undefined);

          assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
          assert.isTrue(fake.window.isDestroyed());
          assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
          assert.equal(fake.loadURL.mock.calls.length, 0);
          assert.equal(fake.openDevTools.mock.calls.length, 0);
          assert.equal(fake.send.mock.calls.length, 0);
          assert.equal(reveal.mock.calls.length, 0);
          assert.deepEqual(warnings, []);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false })),
          ),
        );
      }),
  );

  it.effect("persists normal bounds and state for a maximized window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.isMaximized.mockReturnValue(true);
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 220, y: 140, width: 1380, height: 920 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 220, y: 140, width: 1380, height: 920 }]);
        assert.deepEqual(mainWindowMaximizedUpdates, [true]);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("preserves unrestorable bounds until the user changes the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 2040, y: 80, width: 1320, height: 880 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        const move = fakeWindow.windowListeners.get("move");
        if (!close || !move) {
          return yield* Effect.die("window lifecycle listeners were not registered");
        }

        close();
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, []);

        fakeWindow.getBounds.mockReturnValue({ x: 80, y: 60, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 80, y: 60, width: 1280, height: 840 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when minimized before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: -32_000, y: -32_000, width: 160, height: 28 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 180, y: 120, width: 1440, height: 960 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isMinimized.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 180, y: 120, width: 1440, height: 960 }]);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );
});
