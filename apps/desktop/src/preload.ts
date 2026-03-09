import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const LAUNCHER_STATE_CHANNEL = "desktop:launcher-state";
const LAUNCHER_GET_STATE_CHANNEL = "desktop:launcher-get-state";
const LAUNCHER_INSTALL_CHANNEL = "desktop:launcher-install";
const PROJECT_OPEN_CHANNEL = "desktop:project-open";
const PROJECT_OPEN_GET_PENDING_CHANNEL = "desktop:project-open-get-pending";
const PROJECT_OPEN_CLEAR_PENDING_CHANNEL = "desktop:project-open-clear-pending";
const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  getLauncherState: () => ipcRenderer.invoke(LAUNCHER_GET_STATE_CHANNEL),
  installLauncher: (options) => ipcRenderer.invoke(LAUNCHER_INSTALL_CHANNEL, options),
  onLauncherState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(LAUNCHER_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(LAUNCHER_STATE_CHANNEL, wrappedListener);
    };
  },
  getPendingProjectPath: () => ipcRenderer.invoke(PROJECT_OPEN_GET_PENDING_CHANNEL),
  clearPendingProjectPath: () => ipcRenderer.invoke(PROJECT_OPEN_CLEAR_PENDING_CHANNEL),
  onProjectOpen: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, cwd: unknown) => {
      if (typeof cwd !== "string" || cwd.trim().length === 0) return;
      listener(cwd);
    };

    ipcRenderer.on(PROJECT_OPEN_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(PROJECT_OPEN_CHANNEL, wrappedListener);
    };
  },
} satisfies DesktopBridge);
