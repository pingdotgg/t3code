import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

import type * as DesktopComponentLogger from "../app/DesktopObservability.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { buildConnectingSplashDataUrl, getInitialWindowBackgroundColor } from "./DesktopWindowChrome.ts";

export interface ConnectingSplashDeps {
  readonly quitting: Effect.Effect<boolean>;
  readonly splashWindowRef: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly electronWindow: ElectronWindow.ElectronWindow["Service"];
  readonly electronTheme: ElectronTheme.ElectronTheme["Service"];
  readonly displayName: string;
  readonly rendererHistory: DesktopRendererHistory.DesktopRendererHistory["Service"];
  /** Clears the splash slot once the window reports `closed`. */
  readonly clearSplashRef: () => void;
  readonly logInfo: DesktopComponentLogger.DesktopComponentLogger["logInfo"];
  readonly logWarning: DesktopComponentLogger.DesktopComponentLogger["logWarning"];
}

/** Shows the frameless "Connecting to WSL…" splash while the backend boots. */
export function makeShowConnectingSplash(deps: ConnectingSplashDeps): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (yield* deps.quitting) return;
    const existingSplash = yield* Ref.get(deps.splashWindowRef);
    if (Option.isSome(existingSplash)) return;
    const existingWindow = yield* deps.electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) return;

    const shouldUseDarkColors = yield* deps.electronTheme.shouldUseDarkColors;
    if (yield* deps.quitting) return;
    const splash = yield* deps.electronWindow.create({
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
      title: deps.displayName,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (yield* deps.quitting) {
      yield* deps.electronWindow.destroyAll;
      return;
    }
    yield* deps.rendererHistory.register(splash.webContents, { surface: "splash" });
    yield* Ref.set(deps.splashWindowRef, Option.some(splash));
    splash.once("closed", () => {
      deps.clearSplashRef();
    });
    splash.once("ready-to-show", () => {
      if (!splash.isDestroyed()) {
        splash.show();
      }
    });
    void splash.loadURL(buildConnectingSplashDataUrl(shouldUseDarkColors));
    yield* deps.logInfo("connecting splash shown");
  }).pipe(
    Effect.catch((error) =>
      deps.logWarning("failed to show connecting splash", {
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.withSpan("desktop.window.showConnectingSplash"),
  );
}
