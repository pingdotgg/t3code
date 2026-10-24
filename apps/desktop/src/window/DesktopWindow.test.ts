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
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  app: { setBadgeCount: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]),
  },
}));

import * as NetService from "@t3tools/shared/Net";
import { HttpClient } from "effect/http";
import * as BrowserImport from "../preview/BrowserImport/BrowserImport.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopCliCommand from "../app/DesktopCliCommand.ts";
import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as DesktopWebLinks from "../app/DesktopWebLinks.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Stream from "effect/Stream";
import * as DesktopApp from "../app/DesktopApp.ts";
import * as DesktopAppActivation from "../app/DesktopAppActivation.ts";
import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopClerk from "../app/DesktopClerk.ts";
import * as DesktopLegacyLocalStorage from "../app/DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "../app/DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "../app/DesktopLinuxUrlHandler.ts";
import * as DesktopPreReadyPlatform from "../app/DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";

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

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

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
    close: window.close,
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

const layerDesktopClientSettings = Layer.mock(DesktopClientSettings.DesktopClientSettings)({
  get: Effect.succeedNone,
});

const layerElectronApp = Layer.mock(ElectronApp.ElectronApp)({
  quit: Effect.void,
});

const layerDesktopAssets = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.none<string>(),
    icns: Option.none<string>(),
    png: Option.none<string>(),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none<string>()),
} satisfies DesktopAssets.DesktopAssets["Service"]);

const layerDesktopServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.die("unexpected getAdvertisedEndpoints"),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const layerElectronMenu = Layer.succeed(ElectronMenu.ElectronMenu, {
  setApplicationMenu: () => Effect.void,
  popupTemplate: () => Effect.void,
  showContextMenu: () => Effect.succeedNone,
} satisfies ElectronMenu.ElectronMenu["Service"]);

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

const layerDesktopEnvironment = DesktopEnvironment.layer(environmentInput).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({
        T3CODE_PORT: "3773",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
      }),
    ),
  ),
);

const desktopWindowBoundsEquivalence = Schema.toEquivalence(
  DesktopAppSettings.DesktopWindowBoundsSchema,
);

function layerTest(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly createdWindowOptions?: Electron.BrowserWindowConstructorOptions[];
  readonly desktopSettings?: DesktopAppSettings.DesktopSettings;
  readonly mainWindowBoundsUpdates?: DesktopAppSettings.DesktopWindowBounds[];
  readonly mainWindowMaximizedUpdates?: boolean[];
  readonly beforeMainWindowBoundsUpdate?: (
    bounds: DesktopAppSettings.DesktopWindowBounds,
  ) => Effect.Effect<void>;
  readonly setPreviewMainWindow?: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  readonly destroyAll?: Effect.Effect<void>;
  readonly onWindowCreate?: Effect.Effect<void>;
  readonly openedExternalUrls?: unknown[];
  readonly copiedTexts?: string[];
  readonly onPopupTemplate?: (input: ElectronMenu.ElectronMenuTemplateInput) => Effect.Effect<void>;
  readonly previewZoomReapplies?: number[];
  readonly onReveal?: (window: Electron.BrowserWindow) => void;
  readonly focusedWindow?: Electron.BrowserWindow;
}) {
  let desktopSettings = input.desktopSettings ?? DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
  const layerDesktopAppSettings = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(() => desktopSettings),
    load: Effect.sync(() => desktopSettings),
    setMainWindowBounds: (bounds, isMaximized) =>
      Effect.gen(function* () {
        if (input.beforeMainWindowBoundsUpdate) {
          yield* input.beforeMainWindowBoundsUpdate(bounds);
        }
        const changed =
          desktopSettings.mainWindowBounds === null ||
          !desktopWindowBoundsEquivalence(desktopSettings.mainWindowBounds, bounds) ||
          desktopSettings.mainWindowMaximized !== isMaximized;
        if (changed) {
          desktopSettings = {
            ...desktopSettings,
            mainWindowBounds: bounds,
            mainWindowMaximized: isMaximized,
          };
          input.mainWindowBoundsUpdates?.push(bounds);
          input.mainWindowMaximizedUpdates?.push(isMaximized);
        }
        return { settings: desktopSettings, changed };
      }),
    setServerExposureMode: () => Effect.die("unexpected server exposure update"),
    setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
    setUpdateChannel: () => Effect.die("unexpected update channel change"),
    setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
    setWslDistro: () => Effect.die("unexpected WSL distro change"),
    setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
    setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
    applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
    applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
  } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

  const layerElectronWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Effect.sync(() => {
        input.createdWindowOptions?.push(options);
      }).pipe(
        Effect.andThen(Ref.update(input.createCount, (count) => count + 1)),
        Effect.andThen(input.onWindowCreate ?? Effect.void),
        Effect.as(input.window),
      ),
    main: Ref.get(input.mainWindow),
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst:
      input.focusedWindow === undefined
        ? Ref.get(input.mainWindow)
        : Effect.succeedSome(input.focusedWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    prepareReveal: () => Effect.succeed(false),
    reveal: (window) => Effect.sync(() => input.onReveal?.(window)),
    sendAll: () => Effect.void,
    destroyAll: input.destroyAll ?? Effect.void,
    syncAllAppearance: (sync) => sync(input.window),
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDesktopAssets,
        Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
          register: () => Effect.void,
          recordMetrics: () => Effect.void,
          shutdown: Effect.void,
        }),
        layerDesktopEnvironment,
        layerDesktopAppSettings,
        layerDesktopClientSettings,
        layerDesktopServerExposure,
        DesktopState.layer,
        layerElectronApp,
        Layer.succeed(ElectronMenu.ElectronMenu, {
          setApplicationMenu: () => Effect.void,
          showContextMenu: () => Effect.succeedNone,
          popupTemplate: input.onPopupTemplate ?? (() => Effect.void),
        }),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: (url) =>
            Effect.sync(() => {
              input.openedExternalUrls?.push(url);
              return true;
            }),
          openSystemSettings: () => Effect.succeed(true),
          copyText: (text) =>
            Effect.sync(() => {
              input.copiedTexts?.push(text);
            }),
        } satisfies ElectronShell.ElectronShell["Service"]),
        layerElectronTheme,
        layerElectronWindow,
        Layer.mock(PreviewPasskeys.PreviewPasskeys)({
          bridgeEnabled: false,
          installSessionHandlers: () => {},
          attachGuest: () => () => {},
        }),
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          setMainWindow: input.setPreviewMainWindow ?? (() => Effect.void),
          prepareWebview: () => Effect.void,
          isBrowserPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
          getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"),
          reapplyZoom: () =>
            Effect.sync(() => {
              input.previewZoomReapplies?.push(input.window.webContents.getZoomLevel());
            }),
        }),
      ),
    ),
    Layer.merge(DesktopState.layer),
  );
}

const makeSplashScenario = (
  createOutcomes: readonly (Electron.BrowserWindow | null)[],
  settings = DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
) =>
  Effect.gen(function* () {
    const createdWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const createCalls = yield* Ref.make(0);
    const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
    const revealedWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const fallbackWindow = createOutcomes.find(
      (window): window is Electron.BrowserWindow => window !== null,
    );

    const currentMainOrFirst = Effect.gen(function* () {
      const registered = yield* Ref.get(mainWindow);
      if (Option.isSome(registered)) {
        return registered;
      }
      const created = yield* Ref.get(createdWindows);
      return Option.fromNullishOr(created.find((window) => !window.isDestroyed()) ?? null);
    });

    const electronWindowShape = {
      create: () =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(createCalls, (count) => count + 1);
          const outcome = createOutcomes[index] ?? null;
          if (outcome === null) {
            return yield* new ElectronWindow.ElectronWindowCreateError({
              options: {
                title: null,
                width: null,
                height: null,
                minWidth: null,
                minHeight: null,
                show: null,
                modal: null,
                frame: null,
                transparent: null,
                backgroundColor: null,
                webPreferences: {
                  preload: null,
                  partition: null,
                  backgroundThrottling: null,
                  sandbox: null,
                  contextIsolation: null,
                  nodeIntegration: null,
                  webviewTag: null,
                },
              },
              cause: new Error("simulated window-open failure"),
            });
          }
          yield* Ref.update(createdWindows, (windows) => [...windows, outcome]);
          return outcome;
        }),
      main: Ref.get(mainWindow),
      currentMainOrFirst,
      focusedMainOrFirst: currentMainOrFirst,
      setMain: (window) => Ref.set(mainWindow, Option.some(window)),
      clearMain: () => Ref.set(mainWindow, Option.none()),
      prepareReveal: () => Effect.succeed(false),
      reveal: (window) => Ref.update(revealedWindows, (windows) => [...windows, window]),
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: (sync) => (fallbackWindow ? sync(fallbackWindow) : Effect.void),
    } satisfies ElectronWindow.ElectronWindow["Service"];

    const layer = DesktopWindow.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          layerDesktopAssets,
          Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
            register: () => Effect.void,
            recordMetrics: () => Effect.void,
            shutdown: Effect.void,
          }),
          layerDesktopEnvironment,
          DesktopAppSettings.layerTest(settings),
          layerDesktopClientSettings,
          layerDesktopServerExposure,
          DesktopState.layer,
          layerElectronApp,
          layerElectronMenu,
          Layer.succeed(ElectronShell.ElectronShell, {
            openExternal: () => Effect.succeed(true),
            openSystemSettings: () => Effect.succeed(true),
            copyText: () => Effect.void,
          } satisfies ElectronShell.ElectronShell["Service"]),
          layerElectronTheme,
          Layer.succeed(ElectronWindow.ElectronWindow, electronWindowShape),
          Layer.mock(PreviewPasskeys.PreviewPasskeys)({
            configure: Effect.void,
            bridgeEnabled: false,
            installSessionHandlers: () => {},
            attachGuest: () => () => {},
          }),
          Layer.mock(PreviewManager.PreviewManager)({
            subscribeStateChanges: () => Effect.void,
            subscribeRecordingFrames: () => Effect.void,
            subscribeRecordingInputs: () => Effect.void,
            subscribePointerEvents: () => Effect.void,
            subscribeOpenLinks: () => Effect.void,
            getBrowserSession: () => Effect.succeed({} as Electron.Session),
            setMainWindow: () => Effect.void,
            isBrowserPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
            getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"),
          }),
        ),
      ),
    );

    return { layer, createCalls, mainWindow, revealedWindows } as const;
  });

const captureOne = DesktopSnapShotId.make("11111111-1111-4111-8111-111111111111");
const captureTwo = DesktopSnapShotId.make("22222222-2222-4222-8222-222222222222");

describe("DesktopWindow", () => {
  it.effect.each([
    { mode: "native", localEnvironmentEnabled: true, wslBackendEnabled: false, wslOnly: false },
    { mode: "WSL-only", localEnvironmentEnabled: true, wslBackendEnabled: true, wslOnly: true },
    { mode: "dual", localEnvironmentEnabled: true, wslBackendEnabled: true, wslOnly: false },
    { mode: "disabled", localEnvironmentEnabled: false, wslBackendEnabled: false, wslOnly: false },
  ])("hands startup from the splash to the main window in $mode mode", (settings) =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario(
        settings.localEnvironmentEnabled ? [splash.window, main.window] : [main.window],
        { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, ...settings },
      );
      const bootstrapped = yield* Deferred.make<void>();
      const windowsAtBackendStart: number[] = [];
      const primary = {
        id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
        label: Effect.succeed("Primary"),
        start: Ref.get(scenario.createCalls).pipe(
          Effect.tap((count) => Effect.sync(() => windowsAtBackendStart.push(count))),
          Effect.asVoid,
        ),
        stop: () => Effect.void,
        currentConfig: Effect.succeedNone,
        snapshot: Effect.never,
        waitForReady: () => Effect.succeed(false),
      } satisfies DesktopBackendPool.DesktopBackendInstance;
      const startupLayer = Layer.mergeAll(
        // IPC registration captures these services but startup does not invoke their handlers.
        Layer.mock(BrowserImport.BrowserImport)({}),
        Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration)({}),
        Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth)({}),
        Layer.mock(DesktopCliCommand.DesktopCliCommand)({}),
        Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore)({}),
        Layer.mock(DesktopWebLinks.DesktopWebLinks)({}),
        Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment)({}),
        Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts)({}),
        Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment)({}),
        Layer.mock(MacPermissions.MacPermissions)({}),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected HTTP request")),
        ),
        Layer.mock(NetService.NetService)({}),
        Layer.mock(ElectronApp.ElectronApp)({
          whenReady: Effect.void,
          setPath: () => Effect.void,
          on: () => Effect.void,
        }),
        Layer.mock(DesktopAppIdentity.DesktopAppIdentity)({
          resolveUserDataPath: Effect.succeed("/unused"),
          configure: Effect.void,
        }),
        Layer.mock(DesktopLifecycle.DesktopLifecycle)({ register: Effect.void }),
        Layer.mock(DesktopClerk.DesktopClerk)({ configure: Effect.void }),
        Layer.mock(DesktopApplicationMenu.DesktopApplicationMenu)({ configure: Effect.void }),
        Layer.mock(DesktopLinuxUrlHandler.DesktopLinuxUrlHandler)({ register: Effect.void }),
        Layer.mock(DesktopShellEnvironment.DesktopShellEnvironment)({
          installIntoProcess: Effect.succeed(true),
        }),
        Layer.succeed(DesktopPreReadyPlatform.DesktopPreReadyElectronOptions, {
          linux: null,
          linuxPasswordStoreCommandLine: null,
        }),
        Layer.mock(ElectronSafeStorage.ElectronSafeStorage)({}),
        Layer.mock(ElectronProtocol.ElectronProtocol)({
          registerDesktopProtocol: () => Effect.void,
        }),
        Layer.mock(ElectronDialog.ElectronDialog)({}),
        Layer.mock(DesktopIpc.DesktopIpc)({
          handle: () => Effect.void,
          handleSync: () => Effect.void,
        }),
        Layer.mock(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage)({
          load: () => Effect.void,
        }),
        Layer.mock(DesktopSnapShot.DesktopSnapShot)({ initialize: Effect.void }),
        Layer.mock(DesktopAppActivation.DesktopAppActivation)({ start: Effect.void }),
        Layer.mock(DesktopWslBackend.DesktopWslBackend)({ reconcile: Effect.void }),
        Layer.mock(DesktopBackendPool.DesktopBackendPool)({
          primary: Effect.succeed(primary),
          list: Effect.succeed([]),
        }),
        Layer.mock(DesktopServerExposure.DesktopServerExposure)({
          configureFromSettings: () =>
            Effect.succeed({
              mode: "local-only",
              advertisedHost: null,
              endpointUrl: null,
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            }),
          backendConfig: Effect.succeed({
            port: 3773,
            bindHost: "127.0.0.1",
            httpBaseUrl: new URL("http://127.0.0.1:3773"),
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          }),
        }),
        Layer.mock(DesktopUpdates.DesktopUpdates)({
          configure: Effect.void,
          subscribe: Effect.never,
        }),
        Layer.mock(DesktopTelemetryPublisher.DesktopTelemetryPublisher)({
          updateRequests: Stream.empty,
          updateCancellations: Stream.empty,
          updateCommits: Stream.empty,
        }),
        Layer.mock(DesktopShutdown.DesktopShutdown)({
          awaitRequest: Deferred.succeed(bootstrapped, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          markComplete: Effect.void,
        }),
        Layer.succeed(HostProcess.Platform, "darwin"),
        NodeServices.layer,
      );
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const app = yield* DesktopApp.program.pipe(Effect.forkScoped);
        yield* Effect.raceFirst(Deferred.await(bootstrapped), Fiber.join(app));

        assert.deepEqual(windowsAtBackendStart, settings.localEnvironmentEnabled ? [1] : []);
        assert.equal(yield* Ref.get(scenario.createCalls), 1);
        if (settings.localEnvironmentEnabled) {
          assert.isTrue(Option.isNone(yield* Ref.get(scenario.mainWindow)));
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
          assert.equal(yield* Ref.get(scenario.createCalls), 2);
        }
        assert.deepEqual(yield* Ref.get(scenario.mainWindow), Option.some(main.window));
        assert.equal(splash.close.mock.calls.length, 0);
        const readyToShow = main.windowListeners.get("ready-to-show");
        assert.isDefined(readyToShow);
        readyToShow();
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [main.window]);
        assert.equal(splash.close.mock.calls.length, settings.localEnvironmentEnabled ? 1 : 0);
        readyToShow();
        assert.equal(splash.close.mock.calls.length, settings.localEnvironmentEnabled ? 1 : 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(scenario.layer, startupLayer, DesktopState.layer)),
      );
    }),
  );

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

  // Chromium hands the main window's zoom level down to embedded preview
  // guests, so every app zoom has to put the preview browser back at its own
  // zoom or zooming the UI drags the previewed page with it.
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

  // Ctrl+wheel bypasses the menu accelerators, so it has to take the same
  // zoom step, preview restore included, from the window's zoom-changed event.
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

  it.effect("shows the splash again on activate after it was closed during startup", () =>
    Effect.gen(function* () {
      const closedSplash = makeFakeBrowserWindow();
      const reopenedSplash = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([closedSplash.window, reopenedSplash.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        closedSplash.isDestroyed.mockReturnValue(true);
        const closed = closedSplash.windowListeners.get("closed");
        assert.isDefined(closed);
        closed();

        yield* desktopWindow.activate;
        assert.equal(yield* Ref.get(scenario.createCalls), 2);
        assert.isTrue(Option.isNone(yield* Ref.get(scenario.mainWindow)));
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
