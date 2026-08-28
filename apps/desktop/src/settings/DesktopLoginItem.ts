import type { DesktopOpenAtLoginState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";

export const readOpenAtLoginState = Effect.fn("desktop.loginItem.readState")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const settings = yield* appSettings.get;
  return {
    enabled: settings.openAtLogin,
    available: environment.isPackaged,
  } satisfies DesktopOpenAtLoginState;
});

export const applyOpenAtLogin = Effect.fn("desktop.loginItem.apply")(function* (enabled: boolean) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.isPackaged) {
    return;
  }

  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.setLoginItemSettings({ openAtLogin: enabled });
});

export const setOpenAtLogin = Effect.fn("desktop.loginItem.set")(function* (enabled: boolean) {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  yield* applyOpenAtLogin(enabled);
  yield* appSettings.setOpenAtLogin(enabled);
  return yield* readOpenAtLoginState();
});
