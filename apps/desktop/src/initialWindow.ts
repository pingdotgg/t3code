// @effect-diagnostics nodeBuiltinImport:off -- This entry creates the native main window before loading the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Electron from "electron";
import { configureBeforeReady } from "./app/configureBeforeReady.ts";
import {
  desktopBootState,
  setDesktopBootState,
  type DesktopBootState,
} from "./app/desktopBootState.ts";
import { earlyDesktopSettingsPath, parseEarlySettings } from "./app/earlySettings.ts";
import { registerDesktopSchemePrivilegesSync } from "./electron/schemePrivileges.ts";
import {
  mainWindowOptions,
  normalizeMainWindowBounds,
  resolveInitialMainWindowBounds,
} from "./window/mainWindowOptions.ts";
import { resolveDesktopAppBranding } from "./app/desktopBranding.ts";

export function start(loadMain: () => void): void {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Boot runs before HostProcess or any Effect runtime exists.
  const platform = process.platform;
  if (!Electron.app.isPackaged || platform === "win32" || process.env.VITE_DEV_SERVER_URL?.trim()) {
    loadMain();
    return;
  }
  try {
    const homeDirectory = NodeOS.homedir();
    const appData =
      platform === "darwin"
        ? NodePath.join(homeDirectory, "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME?.trim() || NodePath.join(homeDirectory, ".config");
    Electron.app.setPath("userData", NodePath.join(appData, "t3code-v2"));
    if (!Electron.app.requestSingleInstanceLock()) {
      Electron.app.quit();
      return;
    }
    const pendingLinkEvents: Array<() => void> = [];
    const onUrl = (event: Electron.Event, url: string) => {
      event.preventDefault();
      pendingLinkEvents.push(() => Electron.app.emit("open-url", event, url));
    };
    const onSecondInstance = (
      event: Electron.Event,
      argv: string[],
      directory: string,
      data: unknown,
    ) => {
      pendingLinkEvents.push(() =>
        Electron.app.emit("second-instance", event, argv, directory, data),
      );
    };
    Electron.app.on("open-url", onUrl);
    Electron.app.on("second-instance", onSecondInstance);
    const state: DesktopBootState = {
      preReadyOptions: configureBeforeReady(platform, homeDirectory),
      replayLinkEvents: () => {
        for (const replay of pendingLinkEvents.splice(0)) replay();
      },
      detachLinkListeners: () => {
        Electron.app.removeListener("open-url", onUrl);
        Electron.app.removeListener("second-instance", onSecondInstance);
      },
      window: undefined,
    };
    registerDesktopSchemePrivilegesSync();
    setDesktopBootState(state);
    Electron.app.once("ready", () => {
      try {
        let settings: Record<string, unknown> = {};
        try {
          settings = parseEarlySettings(
            NodeFS.readFileSync(
              earlyDesktopSettingsPath({
                env: process.env,
                homeDirectory,
                joinPath: NodePath.join,
              }),
              "utf8",
            ),
          );
        } catch {}
        const bounds = normalizeMainWindowBounds(settings.mainWindowBounds);
        const dark = Electron.nativeTheme.shouldUseDarkColors;
        let displays: Electron.Rectangle[] = [];
        try {
          displays = Electron.screen.getAllDisplays().map((display) => display.bounds);
        } catch {}
        const window = new Electron.BrowserWindow(
          mainWindowOptions({
            bounds: resolveInitialMainWindowBounds(bounds, displays),
            platform,
            shouldUseDarkColors: dark,
            title: resolveDesktopAppBranding({
              isDevelopment: false,
              appVersion: Electron.app.getVersion(),
            }).displayName,
            preloadPath: NodePath.join(__dirname, "preload.cjs"),
            ...(platform === "darwin"
              ? {}
              : {
                  icon: NodePath.join(
                    Electron.app.getAppPath(),
                    "apps/desktop/prod-resources/icon.png",
                  ),
                }),
          }),
        );
        state.window = window;
        window.once("closed", () => {
          if (desktopBootState()?.window === window) Electron.app.quit();
        });
        if (bounds && settings.mainWindowMaximized === true) window.maximize();
        window.show();
        // Let the native show reach the display server before synchronous module evaluation.
        setImmediate(() => {
          if (!window.isDestroyed()) loadMain();
        });
      } catch (cause) {
        fail(cause);
      }
    });
  } catch (cause) {
    fail(cause);
  }
}

function fail(cause: unknown): void {
  Electron.dialog.showErrorBox(
    "T3 Code failed to start",
    cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
  );
  Electron.app.exit(1);
}
