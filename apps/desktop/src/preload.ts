import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const BROWSER_ENSURE_TAB_CHANNEL = "desktop:browser-ensure-tab";
const BROWSER_NAVIGATE_CHANNEL = "desktop:browser-navigate";
const BROWSER_GO_BACK_CHANNEL = "desktop:browser-go-back";
const BROWSER_GO_FORWARD_CHANNEL = "desktop:browser-go-forward";
const BROWSER_RELOAD_CHANNEL = "desktop:browser-reload";
const BROWSER_CLOSE_TAB_CHANNEL = "desktop:browser-close-tab";
const BROWSER_SYNC_HOST_CHANNEL = "desktop:browser-sync-host";
const BROWSER_CLEAR_THREAD_CHANNEL = "desktop:browser-clear-thread";
const BROWSER_EVENT_CHANNEL = "desktop:browser-event";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  browserEnsureTab: (input) => ipcRenderer.invoke(BROWSER_ENSURE_TAB_CHANNEL, input),
  browserNavigate: (input) => ipcRenderer.invoke(BROWSER_NAVIGATE_CHANNEL, input),
  browserGoBack: (input) => ipcRenderer.invoke(BROWSER_GO_BACK_CHANNEL, input),
  browserGoForward: (input) => ipcRenderer.invoke(BROWSER_GO_FORWARD_CHANNEL, input),
  browserReload: (input) => ipcRenderer.invoke(BROWSER_RELOAD_CHANNEL, input),
  browserCloseTab: (input) => ipcRenderer.invoke(BROWSER_CLOSE_TAB_CHANNEL, input),
  browserSyncHost: (input) => ipcRenderer.invoke(BROWSER_SYNC_HOST_CHANNEL, input),
  browserClearThread: (input) => ipcRenderer.invoke(BROWSER_CLEAR_THREAD_CHANNEL, input),
  onBrowserEvent: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (typeof payload !== "object" || payload === null) return;
      listener(payload as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(BROWSER_EVENT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(BROWSER_EVENT_CHANNEL, wrappedListener);
    };
  },
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
} satisfies DesktopBridge);
