import type { DesktopOpenAtLoginState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";

// Electron's login-item APIs only register on Windows and macOS. On Linux they
// are a silent no-op, so packaged Linux must not report the setting as available.
function loginItemAvailable(environment: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
}) {
  return (
    environment.isPackaged &&
    (environment.platform === "darwin" || environment.platform === "win32")
  );
}

export const readOpenAtLoginState = Effect.fn("desktop.loginItem.readState")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const settings = yield* appSettings.get;
  return {
    enabled: settings.openAtLogin,
    available: loginItemAvailable(environment),
  } satisfies DesktopOpenAtLoginState;
});

export const applyOpenAtLogin = Effect.fn("desktop.loginItem.apply")(function* (enabled: boolean) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!loginItemAvailable(environment)) {
    return;
  }

  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.setLoginItemSettings({ openAtLogin: enabled });
});

export const setOpenAtLogin = Effect.fn("desktop.loginItem.set")(function* (enabled: boolean) {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  // Persist first so a failed OS registration cannot leave startup enabled
  // (or disabled) against the on-disk preference. The next launch reapplies
  // whatever we stored.
  yield* appSettings.setOpenAtLogin(enabled);
  yield* applyOpenAtLogin(enabled);
  return yield* readOpenAtLoginState();
});
