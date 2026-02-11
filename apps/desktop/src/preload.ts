import { contextBridge, ipcRenderer } from "electron";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL) as Promise<string | null>,
  showContextMenu: (items: { id: string; label: string }[]) =>
    ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items) as Promise<string | null>,
});
