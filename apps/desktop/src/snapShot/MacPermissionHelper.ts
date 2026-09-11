// @effect-diagnostics globalTimers:off -- Poll TCC only while the native permission helper is open.
import * as Electron from "electron";
import { SNAP_SHOT_PERMISSION_HELPER_CHANNEL } from "../ipc/channels.ts";

import {
  settingsHelperBounds,
  watchMacSettingsWindow,
  type SettingsWindow,
} from "./MacSettingsWindow.ts";

type Permission = "screen-recording" | "accessibility";

const permissionGranted = (permission: Permission) =>
  permission === "screen-recording"
    ? Electron.systemPreferences.getMediaAccessStatus("screen") === "granted"
    : Electron.systemPreferences.isTrustedAccessibilityClient(false);

/** Resolve the outer app bundle, never the executable or the ASAR inside it. */
export function macAppBundlePath(executable: string): string | undefined {
  return /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1];
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

function helperHtml(permission: Permission, icon: string) {
  const title = permission === "screen-recording" ? "Screen Recording" : "Accessibility";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Set up ${title}</title><style>
:root { color-scheme: light dark; --base: #fff; --row: #e7e7e7; --text: #292929; --line: #e3e3e3; }
@media (prefers-color-scheme: dark) { :root { --base: #242424; --row: #383838; --text: #f5f5f5; --line: #484848; } }
* { box-sizing: border-box; }
html { background: transparent; }
body { margin: 0; background: transparent; color: var(--text); font: 15px/22px -apple-system, BlinkMacSystemFont, sans-serif; user-select: none; }
#panel { position: relative; margin: 2px; padding: 20px; height: 136px; border: 1px solid var(--line); border-radius: 24px; background: var(--base); }
header { font-weight: 600; white-space: nowrap; }
button { font: inherit; color: inherit; }
button:focus-visible { outline: 2px solid #007aff; outline-offset: 3px; }
#close { position: absolute; right: 8px; top: 6px; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; background: var(--base); font-size: 18px; cursor: pointer; opacity: 0; }
#panel:hover #close, #close:focus-visible { opacity: 1; }
#app { display: flex; align-items: center; gap: 12px; width: 100%; height: 52px; margin-top: 20px; padding: 8px 12px; border: 0; border-radius: 10px; background: var(--row); cursor: grab; text-align: left; font-size: 16px; font-weight: 600; }
#app:active { cursor: grabbing; }
img { width: 32px; height: 32px; pointer-events: none; }
</style></head><body><main id="panel">
<button id="close" aria-label="Close permission helper">×</button>
<header>↑ Drag T3 Code into the list above</header>
<button id="app" draggable="true" aria-label="Drag T3 Code to System Settings, or click to reveal in Finder"><img src="${escapeHtml(icon)}" alt="" draggable="false">T3 Code</button>
</main></body></html>`;
}

/** Owns one temporary panel and its IPC listener. Closing it releases all resources. */
export class MacPermissionHelper {
  private window: Electron.BrowserWindow | undefined;

  close() {
    this.window?.destroy();
    this.window = undefined;
  }

  async show(
    permission: Permission,
    preload: string,
    owner: Electron.BrowserWindow | null,
    iconPaths: readonly string[],
  ) {
    this.close();
    if (permissionGranted(permission)) return;
    const bundle = macAppBundlePath(Electron.app.getPath("exe"));
    if (!bundle) return;
    if (owner?.isDestroyed()) return;
    // Finder's bundle-icon lookup can return the generic app icon for mounted artifacts.
    // Use the same PNG that packaging uses to generate the app's macOS icon.
    const appIcon = iconPaths
      .map((iconPath) => Electron.nativeImage.createFromPath(iconPath))
      .find((image) => !image.isEmpty());
    if (!appIcon) throw new Error("The packaged T3 Code icon is missing.");
    const icon = appIcon.resize({ width: 64, height: 64 });
    const window = new Electron.BrowserWindow({
      width: 560,
      height: 140,
      show: false,
      frame: false,
      transparent: true,
      roundedCorners: false,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: "Set up snapshots",
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.window = window;
    const finish = () => {
      window.close();
      if (owner && !owner.isDestroyed()) {
        owner.show();
        owner.focus();
      }
    };
    const check = () => {
      if (!window.isDestroyed() && permissionGranted(permission)) {
        finish();
        return true;
      }
      return false;
    };
    const onMessage = (event: Electron.IpcMainEvent, action: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        return;
      if (action === "drag") {
        try {
          window.webContents.startDrag({ file: bundle, icon });
        } catch {
          Electron.shell.showItemInFolder(bundle);
        }
      } else if (action === "finder") {
        Electron.shell.showItemInFolder(bundle);
      } else if (action === "close") {
        finish();
      }
    };
    let settingsWindow: SettingsWindow = null;
    let foundSettings = false;
    let trackingAvailable = true;
    const syncPosition = () => {
      if (window.isDestroyed()) return;
      if (!trackingAvailable) {
        window.hide();
        return;
      }
      if (!settingsWindow && foundSettings) {
        finish();
        return;
      }
      if (!settingsWindow || (!settingsWindow.frontmost && !window.isFocused())) {
        window.hide();
        return;
      }
      const bounds = settingsHelperBounds(settingsWindow);
      const current = window.getBounds();
      if (
        current.x !== bounds.x ||
        current.y !== bounds.y ||
        current.width !== bounds.width ||
        current.height !== bounds.height
      ) {
        window.setBounds(bounds, false);
      }
      if (!window.isVisible()) window.showInactive();
    };
    let stopTracking = () => {};
    window.on("blur", syncPosition);
    const onOwnerClosed = () => window.destroy();
    Electron.ipcMain.on(SNAP_SHOT_PERMISSION_HELPER_CHANNEL, onMessage);
    const timer = setInterval(check, 1_000);
    owner?.once("closed", onOwnerClosed);
    window.once("closed", () => {
      clearInterval(timer);
      stopTracking();
      Electron.ipcMain.removeListener(SNAP_SHOT_PERMISSION_HELPER_CHANNEL, onMessage);
      owner?.removeListener("closed", onOwnerClosed);
      if (this.window === window) this.window = undefined;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    try {
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(helperHtml(permission, icon.toDataURL()))}`,
      );
      if (!window.isDestroyed()) {
        stopTracking = watchMacSettingsWindow(
          (current) => {
            trackingAvailable = true;
            settingsWindow = current;
            if (current) foundSettings = true;
            syncPosition();
          },
          () => {
            trackingAvailable = false;
            syncPosition();
          },
        );
      }
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }
}
