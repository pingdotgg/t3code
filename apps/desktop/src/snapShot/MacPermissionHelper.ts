// @effect-diagnostics globalTimers:off -- Poll TCC only while the native permission helper is open.
import * as Electron from "electron";
import { SNAP_SHOT_PERMISSION_HELPER_CHANNEL } from "../ipc/channels.ts";

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

function helperHtml(permission: Permission, name: string, icon: string) {
  const title = permission === "screen-recording" ? "Screen Recording" : "Accessibility";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Set up snapshots</title><style>
:root { color-scheme: light dark; --base: #fafafa; --row: #eaeaea; --text: #242424; --muted: #606060; --line: #d5d5d5; --focus: #007aff; }
@media (prefers-color-scheme: dark) { :root { --base: #242424; --row: #363636; --text: #f5f5f5; --muted: #b5b5b5; --line: #505050; } }
* { box-sizing: border-box; } body { margin: 0; padding: 20px; background: var(--base); color: var(--text); font: 13px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; }
header { -webkit-app-region: drag; padding-right: 25px; } h1 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
p { margin: 0; color: var(--muted); } button { font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--line); background: var(--base); border-radius: 7px; padding: 5px 10px; }
button:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; } #close { position: absolute; right: 12px; top: 12px; border: 0; font-size: 20px; padding: 0 6px; }
#app { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px; margin: 16px 0 12px; background: var(--row); cursor: grab; text-align: left; font-weight: 600; font-size: 15px; }
#app:active { cursor: grabbing; } img { width: 40px; height: 40px; pointer-events: none; } footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; } #status { min-height: 38px; margin: 12px 0 0; font-size: 12px; }
</style></head><body><button id="close" aria-label="Close permission helper">×</button>
<header><h1>Drag ${escapeHtml(name)} into ${title}</h1><p>Drop the app into the list in System Settings, then turn it on.</p></header>
<button id="app" draggable="true" aria-label="Drag ${escapeHtml(name)} to System Settings, or click to reveal in Finder"><img src="${escapeHtml(icon)}" alt="" draggable="false">${escapeHtml(name)}</button>
<footer><button id="finder">Show in Finder</button><button id="check">Check permission</button></footer>
<p id="status" role="status">If the app is already listed, turn on its toggle.</p></body></html>`;
}

/** Owns one temporary panel and its IPC listener. Closing it releases all resources. */
export class MacPermissionHelper {
  private window: Electron.BrowserWindow | undefined;
  private generation = 0;

  close() {
    this.generation++;
    this.window?.destroy();
    this.window = undefined;
  }

  async show(permission: Permission, preload: string, owner: Electron.BrowserWindow | null) {
    this.close();
    if (permissionGranted(permission)) return;
    const generation = this.generation;
    const bundle = macAppBundlePath(Electron.app.getPath("exe"));
    if (!bundle) return;
    const icon = await Electron.app.getFileIcon(bundle, { size: "normal" });
    if (generation !== this.generation || owner?.isDestroyed()) return;
    const display = owner
      ? Electron.screen.getDisplayMatching(owner.getBounds())
      : Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint());
    const area = display.workArea;
    const width = Math.min(460, area.width);
    const height = 310;
    const window = new Electron.BrowserWindow({
      width,
      height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.max(area.y, area.y + area.height - height - 28),
      show: false,
      frame: false,
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
          window.webContents.send(
            SNAP_SHOT_PERMISSION_HELPER_CHANNEL,
            "Could not start dragging. Use Show in Finder, then drag the app from there.",
          );
        }
      } else if (action === "finder") {
        Electron.shell.showItemInFolder(bundle);
      } else if (action === "close") {
        finish();
      } else if (action === "check" && !check()) {
        window.webContents.send(
          SNAP_SHOT_PERMISSION_HELPER_CHANNEL,
          "Permission is still required. If you enabled it, quit and reopen T3 Code to finish setup.",
        );
      }
    };
    const onOwnerClosed = () => window.destroy();
    Electron.ipcMain.on(SNAP_SHOT_PERMISSION_HELPER_CHANNEL, onMessage);
    const timer = setInterval(check, 1_000);
    owner?.once("closed", onOwnerClosed);
    window.once("closed", () => {
      clearInterval(timer);
      Electron.ipcMain.removeListener(SNAP_SHOT_PERMISSION_HELPER_CHANNEL, onMessage);
      owner?.removeListener("closed", onOwnerClosed);
      if (this.window === window) this.window = undefined;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    try {
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(helperHtml(permission, Electron.app.getName(), icon.toDataURL()))}`,
      );
      if (!window.isDestroyed()) window.showInactive();
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }
}
