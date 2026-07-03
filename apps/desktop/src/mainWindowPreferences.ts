import type { BrowserWindowConstructorOptions } from "electron";

export function createMainWindowWebPreferences(
  preloadPath: string,
): NonNullable<BrowserWindowConstructorOptions["webPreferences"]> {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: true,
  };
}
