import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

import { type DesktopSnapShotEvent, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  MENU_ACTION_CHANNEL,
  QUIT_SHORTCUT_CHANNEL,
  SNAP_SHOT_EVENT_CHANNEL,
  TRACKPAD_SCROLL_BEGIN_CHANNEL,
  TRACKPAD_SCROLL_END_CHANNEL,
  WINDOW_FULLSCREEN_STATE_CHANNEL,
} from "../ipc/channels.ts";
import { PASSKEY_BRIDGE_ARGUMENT } from "../preview/GuestProtocol.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import { makeQuitShortcutHandler } from "./QuitHold.ts";
import { copyContextMenuImage } from "./ContextMenuImage.ts";

const TITLEBAR_HEIGHT = 40;
// Match --workspace-topbar-height in apps/web/src/index.css; native macOS buttons stay 14 points at any zoom.
const MACOS_WORKSPACE_TOPBAR_HEIGHT = 52;
const MACOS_WINDOW_BUTTON_RADIUS = 7;

function syncMacosWindowButtons(window: Electron.BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round(
      (MACOS_WORKSPACE_TOPBAR_HEIGHT * window.webContents.getZoomFactor()) / 2 -
        MACOS_WINDOW_BUTTON_RADIUS,
    ),
  });
}

const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([-2, -7, -9, -102, -105, -106, -118]);

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopState.DesktopState
  | DesktopAssets.DesktopAssets
  | DesktopAppSettings.DesktopAppSettings
  | DesktopClientSettings.DesktopClientSettings
  | ElectronApp.ElectronApp
  | ElectronMenu.ElectronMenu
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | DesktopRendererHistory.DesktopRendererHistory
  | PreviewManager.PreviewManager;

export type DesktopWindowError =
  | ElectronWindow.ElectronWindowCreateError
  | PreviewManager.PreviewManagerError;

export type MainWindowZoomDirection = "in" | "out" | "reset";
export type MainWindowContentsCommand = "reload" | "forceReload" | "toggleDevTools";

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    readonly createMainIfBackendReady: Effect.Effect<void, DesktopWindowError>;
    readonly showConnectingSplash: Effect.Effect<void>;
    readonly handleBackendReady: (httpBaseUrl: URL) => Effect.Effect<void, DesktopWindowError>;
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly flushMainWindowBounds: Effect.Effect<void>;
    readonly prepareCaptureReveal: Effect.Effect<void>;
    readonly dispatchMenuAction: (
      action: string,
      options?: { readonly reveal?: boolean },
    ) => Effect.Effect<void, DesktopWindowError>;
    readonly dispatchSnapShotEvent: (
      event: DesktopSnapShotEvent,
    ) => Effect.Effect<void, DesktopWindowError>;
    // Electron zoom roles target focused guests; zoomMain must always target the app.
    readonly zoomMain: (direction: MainWindowZoomDirection) => Effect.Effect<void>;
    readonly runMainContentsCommand: (command: MainWindowContentsCommand) => Effect.Effect<void>;
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopWindow") {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  makeComponentLogger("desktop-window");

function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): { icon: string } | Record<string, never> {
  if (platform === "darwin") return {};
  const ext = platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#000000" : "#ffffff";
}

type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  return (
    windowBounds.x >= displayBounds.x &&
    windowBounds.y >= displayBounds.y &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height
  );
}

function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }
  return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
}

function buildConnectingSplashDataUrl(shouldUseDarkColors: boolean): string {
  const background = getInitialWindowBackgroundColor(shouldUseDarkColors);
  const label = shouldUseDarkColors ? "#9ca3af" : "#6b7280";
  const accent = shouldUseDarkColors ? "#f8fafc" : "#1f2937";
  const track = shouldUseDarkColors ? "rgba(248,250,252,0.18)" : "rgba(31,41,55,0.18)";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%}body{background:${background};color:${label};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}.spinner{width:26px;height:26px;border:3px solid ${track};border-top-color:${accent};border-radius:50%;animation:spin .8s linear infinite}.label{font-size:13px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="spinner"></div><div class="label">Connecting to WSL…</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    const applicationUrl = new URL(input.applicationUrl);
    const navigationUrl = new URL(input.navigationUrl);
    // Node serializes custom-scheme origins as "null", even for different hosts and schemes.
    return (
      applicationUrl.host !== "" &&
      navigationUrl.protocol === applicationUrl.protocol &&
      navigationUrl.host === applicationUrl.host
    );
  } catch {
    return false;
  }
}

function isRetryableDevelopmentRendererLoadFailure(input: {
  readonly applicationUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  readonly validatedUrl: string;
}): boolean {
  return (
    input.isMainFrame &&
    DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(input.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: input.validatedUrl,
    })
  );
}

function concealPendingQuitWindow(
  window: Pick<
    Electron.BrowserWindow,
    "isDestroyed" | "isFullScreen" | "setFullScreen" | "setOpacity"
  >,
): void {
  if (window.isDestroyed()) return;
  if (window.isFullScreen()) {
    window.setFullScreen(false);
  }
  // Linux lacks Electron window opacity; release-gated quits remain visible there.
  window.setOpacity(0);
}

function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors, platform);
    if (typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

type RevealSubscription = (listener: () => void) => void;

function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const previewManager = yield* PreviewManager.PreviewManager;
  const previewPasskeys = yield* PreviewPasskeys.PreviewPasskeys;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const backendReadyRef = yield* Ref.make(false);
  const splashWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  let flushMainWindowBounds: Effect.Effect<void> = Effect.void;

  const dismissConnectingSplash = Effect.gen(function* () {
    const splash = yield* Ref.getAndSet(splashWindowRef, Option.none());
    if (Option.isSome(splash) && !splash.value.isDestroyed()) {
      splash.value.close();
    }
  });

  // Electron's first-window fallback can select the unregistered connecting splash; exclude it so main creation retries.
  const withoutSplash = (window: Option.Option<Electron.BrowserWindow>) =>
    Ref.get(splashWindowRef).pipe(
      Effect.map((splash) =>
        Option.isSome(splash) && Option.isSome(window) && window.value === splash.value
          ? Option.none<Electron.BrowserWindow>()
          : window,
      ),
    );

  const currentMainWindow = electronWindow.currentMainOrFirst.pipe(Effect.flatMap(withoutSplash));
  const focusedMainWindow = electronWindow.focusedMainOrFirst.pipe(Effect.flatMap(withoutSplash));

  const zoomWindow = Effect.fn("desktop.window.zoomWindow")(function* (
    window: Electron.BrowserWindow,
    direction: MainWindowZoomDirection,
  ) {
    const webContents = window.webContents;
    webContents.setZoomLevel(
      direction === "reset" ? 0 : webContents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
    );
    if (environment.platform === "darwin") syncMacosWindowButtons(window);
    // App zoom propagates to guests; restore each preview's own zoom.
    yield* previewManager.reapplyZoom();
  });

  const createWindow = Effect.fn("desktop.window.createWindow")(function* (): Effect.fn.Return<
    Option.Option<Electron.BrowserWindow>,
    DesktopWindowError
  > {
    if (yield* Ref.get(desktopState.quitting)) return Option.none();
    yield* previewManager.getBrowserSession();
    const applicationUrl = getDesktopUrl(environment.isDevelopment);
    const iconPaths = yield* assets.iconPaths;
    const iconOption = getIconOption(iconPaths, environment.platform);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const persistedSettings = yield* desktopSettings.get;
    const persistedBounds = persistedSettings.mainWindowBounds;
    const displayBoundsResult = yield* Effect.sync(() => {
      try {
        return {
          _tag: "Success" as const,
          bounds: Electron.screen.getAllDisplays().map((display) => display.bounds),
        };
      } catch (cause) {
        return { _tag: "Failure" as const, cause };
      }
    });
    const displayBounds =
      displayBoundsResult._tag === "Success"
        ? displayBoundsResult.bounds
        : yield* logWindowWarning("failed to read connected displays; using defaults", {
            cause: displayBoundsResult.cause,
          }).pipe(Effect.as<readonly Electron.Rectangle[]>([]));
    const initialBounds = resolveInitialMainWindowBounds(persistedBounds, displayBounds);
    const restoredPersistedBounds = persistedBounds !== null && initialBounds === persistedBounds;
    if (persistedBounds !== null && initialBounds === DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE) {
      yield* logWindowWarning("saved main window bounds could not be restored; using defaults");
    }
    if (yield* Ref.get(desktopState.quitting)) return Option.none();
    const window = yield* electronWindow.create({
      ...initialBounds,
      minWidth: 840,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      ...(environment.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      ...iconOption,
      title: environment.displayName,
      ...getWindowTitleBarOptions(shouldUseDarkColors, environment.platform),
      webPreferences: {
        preload: environment.preloadPath,
        // Hidden-renderer throttling stalls first paint; re-enable it after the first reveal.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        // Guest fullscreen propagates to the embedder; both must opt out to keep it inside the webview.
        disableHtmlFullscreenWindowResize: true,
      },
    });
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;
      return Option.none();
    }

    yield* rendererHistory.register(window.webContents, { surface: "main" });
    if (environment.platform === "darwin") {
      window.setAutoHideCursor(false);
    }
    let boundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let pendingBoundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let boundsPersistenceEnabled = persistedBounds === null || restoredPersistedBounds;
    const readPersistableBounds = (): DesktopAppSettings.DesktopWindowBounds | null => {
      if (window.isDestroyed()) {
        return null;
      }
      const bounds =
        window.isFullScreen() || window.isMaximized() || window.isMinimized()
          ? window.getNormalBounds()
          : window.getBounds();
      return DesktopAppSettings.normalizeMainWindowBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };
    const fallbackWindowBounds = boundsPersistenceEnabled ? null : readPersistableBounds();
    const fallbackWindowMaximized = persistedSettings.mainWindowMaximized;
    const persistCurrentBounds = (): Fiber.Fiber<void, never> | undefined => {
      if (!boundsPersistenceEnabled) {
        return pendingBoundsPersistFiber;
      }
      const bounds = readPersistableBounds();
      if (bounds === null) {
        return pendingBoundsPersistFiber;
      }
      pendingBoundsPersistFiber = runFork(
        desktopSettings.setMainWindowBounds(bounds, window.isMaximized()).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            logWindowWarning("failed to persist main window bounds", {
              message: error.message,
            }),
          ),
        ),
      );
      return pendingBoundsPersistFiber;
    };
    const scheduleBoundsPersist = () => {
      if (!boundsPersistenceEnabled) {
        const currentBounds = readPersistableBounds();
        if (
          currentBounds === null ||
          (fallbackWindowBounds !== null &&
            windowBoundsEqual(currentBounds, fallbackWindowBounds) &&
            window.isMaximized() === fallbackWindowMaximized)
        ) {
          return;
        }
      }
      boundsPersistenceEnabled = true;
      if (boundsPersistFiber !== undefined) {
        const fiber = boundsPersistFiber;
        boundsPersistFiber = undefined;
        runFork(Fiber.interrupt(fiber));
      }
      boundsPersistFiber = runFork(
        Effect.sleep(MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              boundsPersistFiber = undefined;
              void persistCurrentBounds();
            }),
          ),
        ),
      );
    };
    const clearBoundsPersist = () => {
      if (boundsPersistFiber === undefined) {
        return;
      }
      const fiber = boundsPersistFiber;
      boundsPersistFiber = undefined;
      runFork(Fiber.interrupt(fiber));
    };
    const flushBoundsPersist = Effect.sync(() => {
      clearBoundsPersist();
      return persistCurrentBounds();
    }).pipe(
      Effect.flatMap((fiber) =>
        fiber === undefined ? Effect.void : Fiber.join(fiber).pipe(Effect.asVoid),
      ),
    );
    flushMainWindowBounds = flushBoundsPersist;

    yield* previewManager.setMainWindow(window);
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;
      return Option.none();
    }
    window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        typeof params.partition !== "string" ||
        !previewManager.isBrowserPartition(params.partition)
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.sandbox = true;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = false;
      webPreferences.disableHtmlFullscreenWindowResize = true;
      if (previewPasskeys.bridgeEnabled) {
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          PASSKEY_BRIDGE_ARGUMENT,
        ];
      }
    });

    const contextMenuContents = new WeakSet<Electron.WebContents>();
    const installContextMenu = (
      ownerWindow: Electron.BrowserWindow,
      contents: Electron.WebContents,
    ): void => {
      if (contextMenuContents.has(contents)) return;
      contextMenuContents.add(contents);
      contents.on("context-menu", (event, params) => {
        event.preventDefault();
        if (contents.isDestroyed() || ownerWindow.isDestroyed()) return;
        // Right-clicking a guest may leave native editing roles targeting the host renderer.
        contents.focus();

        const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

        if (params.misspelledWord) {
          for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            menuTemplate.push({
              label: suggestion,
              click: () => {
                if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
              },
            });
          }
          if (params.dictionarySuggestions.length === 0) {
            menuTemplate.push({ label: "No suggestions", enabled: false });
          }
          menuTemplate.push({ type: "separator" });
        }

        if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
          menuTemplate.push(
            {
              label: "Copy Link",
              click: () => {
                void runPromise(electronShell.copyText(params.linkURL));
              },
            },
            { type: "separator" },
          );
        }

        if (params.mediaType === "image") {
          menuTemplate.push({
            label: "Copy Image",
            click: () => {
              void runPromise(
                Effect.tryPromise(() => copyContextMenuImage(contents, params)).pipe(
                  Effect.catch(() => logWindowWarning("failed to copy context-menu image")),
                ),
              );
            },
          });
          menuTemplate.push({ type: "separator" });
        }

        menuTemplate.push(
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        );

        void runPromise(
          electronMenu.popupTemplate({
            window: ownerWindow,
            template: menuTemplate,
            ...(params.frame ? { frame: params.frame } : {}),
          }),
        );
      });
      contents.on("did-create-window", (popup) => {
        installContextMenu(popup, popup.webContents);
      });
    };
    installContextMenu(window, window.webContents);
    window.webContents.on("did-attach-webview", (_event, contents) => {
      installContextMenu(window, contents);
      void runPromise(previewManager.prepareWebview(contents));
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (
        isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: url,
        })
      ) {
        return;
      }

      event.preventDefault();
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
    });

    const quitShortcutHandler = makeQuitShortcutHandler({
      platform: environment.platform,
      getMode: () =>
        runPromise(
          Effect.map(
            clientSettings.get,
            Option.match({
              onNone: () => DEFAULT_CLIENT_SETTINGS.confirmQuit,
              onSome: (settings) => settings.confirmQuit,
            }),
          ),
        ),
      notify: (hint) => {
        if (!window.isDestroyed()) {
          window.webContents.send(QUIT_SHORTCUT_CHANNEL, hint);
        }
      },
      // Hold focus until shortcut release so remaining repeats cannot reach the next app.
      concealWindow: () => concealPendingQuitWindow(window),
      quit: () => {
        void runPromise(electronApp.quit);
      },
    });
    window.webContents.on("before-input-event", (event, input) => {
      quitShortcutHandler(event, input);
      // A held Cmd/Ctrl+W closes one tab or terminal, not each one behind it.
      if (input.type !== "keyDown" || !input.isAutoRepeat) return;
      const modifier = environment.platform === "darwin" ? input.meta : input.control;
      if (modifier && !input.alt && !input.shift && input.key.toLowerCase() === "w") {
        event.preventDefault();
      }
    });
    window.webContents.on("input-event", (_event, input) => {
      if (input.type === "gestureScrollBegin") {
        window.webContents.send(TRACKPAD_SCROLL_BEGIN_CHANNEL);
      } else if (input.type === "gestureScrollEnd") {
        window.webContents.send(TRACKPAD_SCROLL_END_CHANNEL);
      }
    });
    // Ctrl+wheel bypasses menus; guest contents emit their own zoom-changed event.
    window.webContents.on("zoom-changed", (_event, direction) => {
      if (window.isDestroyed()) return;
      runFork(zoomWindow(window, direction));
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(environment.displayName);
    });
    window.on("resize", scheduleBoundsPersist);
    window.on("move", scheduleBoundsPersist);
    window.on("maximize", scheduleBoundsPersist);
    window.on("unmaximize", scheduleBoundsPersist);
    window.on("close", () => {
      runFork(flushBoundsPersist);
    });

    if (environment.platform === "darwin") {
      window.on("enter-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, true);
      });
      window.on("leave-full-screen", () => {
        syncMacosWindowButtons(window);
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, false);
      });
    }

    let developmentLoadRetryIndex = 0;
    let developmentLoadRetryFiber: Fiber.Fiber<void, never> | undefined;
    let rendererRecoveryTimestamps: number[] = [];
    const clearDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber === undefined) {
        return;
      }
      const retryFiber = developmentLoadRetryFiber;
      developmentLoadRetryFiber = undefined;
      runFork(Fiber.interrupt(retryFiber));
    };
    const loadApplication = () => {
      if (window.isDestroyed()) {
        return;
      }
      void window.loadURL(applicationUrl).catch(() => undefined);
    };
    const scheduleDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber !== undefined || window.isDestroyed()) {
        return undefined;
      }

      const retryIndex = Math.min(
        developmentLoadRetryIndex,
        DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1,
      );
      const retryInMs = DEVELOPMENT_LOAD_RETRY_DELAYS_MS[retryIndex] ?? 2_000;
      developmentLoadRetryIndex += 1;
      developmentLoadRetryFiber = runFork(
        Effect.sleep(retryInMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              developmentLoadRetryFiber = undefined;
              if (!window.isDestroyed()) {
                loadApplication();
              }
            }),
          ),
        ),
      );
      return retryInMs;
    };

    window.webContents.on("did-finish-load", () => {
      if (
        environment.isDevelopment &&
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }
      clearDevelopmentLoadRetry();
      developmentLoadRetryIndex = 0;
      window.setTitle(environment.displayName);
      if (environment.platform === "darwin") syncMacosWindowButtons(window);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        const retryInMs =
          environment.isDevelopment &&
          isRetryableDevelopmentRendererLoadFailure({
            applicationUrl,
            errorCode,
            isMainFrame,
            validatedUrl: validatedURL,
          })
            ? scheduleDevelopmentLoadRetry()
            : undefined;
        void runPromise(
          logWindowWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
            ...(retryInMs === undefined ? {} : { retryInMs }),
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      const recoverable =
        details.reason === "crashed" ||
        details.reason === "oom" ||
        details.reason === "killed" ||
        details.reason === "abnormal-exit";

      runFork(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
            (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
          );
          const shouldRecover =
            recoverable &&
            !window.isDestroyed() &&
            rendererRecoveryTimestamps.length < RENDERER_RECOVERY_MAX_ATTEMPTS;
          yield* logWindowWarning("main window render process gone", {
            reason: details.reason,
            exitCode: details.exitCode,
            recovering: shouldRecover,
          });
          if (!shouldRecover) {
            return;
          }
          rendererRecoveryTimestamps.push(now);
          yield* Effect.sleep(RENDERER_RECOVERY_RELOAD_DELAY_MS);
          if (!window.isDestroyed()) {
            loadApplication();
          }
        }),
      );
    });

    const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
    if (environment.platform === "linux") {
      revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
    }
    bindFirstRevealTrigger(revealSubscribers, () => {
      if (!window.isDestroyed()) {
        window.webContents.setBackgroundThrottling(true);
      }
      if (persistedSettings.mainWindowMaximized) {
        window.maximize();
      }
      void runPromise(Effect.andThen(electronWindow.reveal(window), dismissConnectingSplash));
    });

    loadApplication();
    if (environment.isDevelopment) {
      window.webContents.openDevTools({ mode: "detach" });
    }

    window.on("closed", () => {
      clearDevelopmentLoadRetry();
      clearBoundsPersist();
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    return Option.some(window);
  });

  const createMain = Effect.gen(function* () {
    const window = yield* createWindow();
    if (Option.isSome(window)) {
      yield* electronWindow.setMain(window.value);
      yield* logWindowInfo("main window created");
    }
    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const ensureMain = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return Option.none<Electron.BrowserWindow>();
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) {
      return existingWindow;
    }
    return yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.ensureMain"));

  const requireWindow = (window: Option.Option<Electron.BrowserWindow>) =>
    Option.match(window, {
      onNone: () => Effect.interrupt,
      onSome: Effect.succeed,
    });

  const revealOrCreateMain = Effect.gen(function* () {
    const window = yield* ensureMain.pipe(Effect.flatMap(requireWindow));
    yield* electronWindow.reveal(window);
    return window;
  }).pipe(Effect.withSpan("desktop.window.revealOrCreateMain"));

  const waitingForBackend = Effect.gen(function* () {
    if (yield* Ref.get(backendReadyRef)) return false;
    return (yield* desktopSettings.get).localEnvironmentEnabled;
  });

  const createMainIfBackendReady = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    if (yield* waitingForBackend) return;
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) return;
    yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  const showConnectingSplash = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    const existingSplash = yield* Ref.get(splashWindowRef);
    if (Option.isSome(existingSplash)) return;
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) return;

    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    if (yield* Ref.get(desktopState.quitting)) return;
    const splash = yield* electronWindow.create({
      width: 360,
      height: 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      center: true,
      show: false,
      skipTaskbar: false,
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      title: environment.displayName,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;
      return;
    }
    yield* rendererHistory.register(splash.webContents, { surface: "splash" });
    yield* Ref.set(splashWindowRef, Option.some(splash));
    splash.once("closed", () => {
      void runPromise(Ref.set(splashWindowRef, Option.none()));
    });
    splash.once("ready-to-show", () => {
      if (!splash.isDestroyed()) {
        splash.show();
      }
    });
    void splash.loadURL(buildConnectingSplashDataUrl(shouldUseDarkColors));
    yield* logWindowInfo("connecting splash shown");
  }).pipe(
    Effect.catch((error) =>
      logWindowWarning("failed to show connecting splash", { message: error.message }),
    ),
    Effect.withSpan("desktop.window.showConnectingSplash"),
  );

  const dispatchRendererEvent = Effect.fn("desktop.window.dispatchRendererEvent")(function* (
    channel: string,
    payload: unknown,
    { reveal = true }: { readonly reveal?: boolean } = {},
  ) {
    if (yield* Ref.get(desktopState.quitting)) return;
    const existingWindow = yield* reveal ? focusedMainWindow : electronWindow.main;
    if (Option.isNone(existingWindow) && (!reveal || (yield* waitingForBackend))) return;
    const window = Option.isSome(existingWindow) ? existingWindow : yield* ensureMain;
    if (Option.isNone(window) || window.value.isDestroyed()) return;
    const targetWindow = window.value;
    const send = Effect.sync(() => {
      if (!targetWindow.isDestroyed()) targetWindow.webContents.send(channel, payload);
    });
    // Send before best-effort reveal; another process may refuse to yield foreground focus.
    const dispatch = reveal
      ? send.pipe(Effect.andThen(electronWindow.reveal(targetWindow).pipe(Effect.ignoreCause)))
      : send;
    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", () => void runPromise(dispatch));
      return;
    }
    yield* dispatch;
  });

  return DesktopWindow.of({
    createMain: createMain.pipe(Effect.flatMap(requireWindow)),
    ensureMain: ensureMain.pipe(Effect.flatMap(requireWindow)),
    revealOrCreateMain,
    prepareCaptureReveal: Effect.gen(function* () {
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.prepareReveal(existingWindow.value);
      }
    }),
    activate: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) return;
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.reveal(existingWindow.value);
        return;
      }
      const backendReady = yield* Ref.get(backendReadyRef);
      if (!backendReady) {
        const splash = yield* Ref.get(splashWindowRef);
        if (Option.isSome(splash)) {
          yield* electronWindow.reveal(splash.value);
          return;
        }
      }
      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.activate")),
    createMainIfBackendReady,
    showConnectingSplash,
    handleBackendReady: Effect.fn("desktop.window.handleBackendReady")(function* (httpBaseUrl) {
      yield* Ref.set(backendReadyRef, true);
      yield* logWindowInfo("backend ready", { source: "http", url: httpBaseUrl.href });
      yield* createMainIfBackendReady;
    }),
    handleBackendNotReady: Ref.set(backendReadyRef, false).pipe(
      Effect.withSpan("desktop.window.handleBackendNotReady"),
    ),
    flushMainWindowBounds: Effect.suspend(() => flushMainWindowBounds).pipe(
      Effect.withSpan("desktop.window.flushMainWindowBounds"),
    ),
    dispatchMenuAction: Effect.fn("desktop.window.dispatchMenuAction")(function* (action, options) {
      yield* Effect.annotateCurrentSpan({ action });
      yield* dispatchRendererEvent(MENU_ACTION_CHANNEL, action, options);
    }),
    dispatchSnapShotEvent: Effect.fn("desktop.window.dispatchSnapShotEvent")(function* (event) {
      yield* Effect.annotateCurrentSpan({
        event: event.type,
        captureId: "id" in event ? (event.id ?? null) : null,
      });
      yield* dispatchRendererEvent(SNAP_SHOT_EVENT_CHANNEL, event, {
        reveal: event.type === "started",
      });
    }),
    zoomMain: Effect.fn("desktop.window.zoomMain")(function* (direction) {
      yield* Effect.annotateCurrentSpan({ direction });
      const window = yield* electronWindow.main;
      if (Option.isNone(window) || window.value.isDestroyed()) {
        return;
      }
      yield* zoomWindow(window.value, direction);
    }),
    runMainContentsCommand: Effect.fn("desktop.window.runMainContentsCommand")(function* (command) {
      yield* Effect.annotateCurrentSpan({ command });
      // A focused OAuth popup must not receive the app's Reload command.
      const window = yield* electronWindow.main;
      if (Option.isNone(window) || window.value.isDestroyed()) return;
      const webContents = window.value.webContents;
      if (command === "reload") webContents.reload();
      else if (command === "forceReload") webContents.reloadIgnoringCache();
      else webContents.toggleDevTools();
    }),
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors, environment.platform),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
