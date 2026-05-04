import * as Effect from "effect/Effect";
import { BrowserWindow } from "electron";
import * as NodeFileSystem from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

import { previewViewManager } from "../../preview-view-manager.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../preview-webview-preferences.ts";
import * as IpcChannels from "../channels.ts";
import type { DesktopIpcMethod } from "../DesktopIpc.ts";

previewViewManager.getBrowserSession();
previewViewManager.onStateChange((tabId, state) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, tabId, state);
    }
  }
});

const tabIdFrom = (raw: unknown): string => {
  if (typeof raw !== "object" || raw === null || !("tabId" in raw)) {
    throw new Error("preview tab id is required");
  }
  const tabId = raw.tabId;
  if (typeof tabId !== "string" || tabId.trim().length === 0) {
    throw new Error("preview tab id must be a non-empty string");
  }
  return tabId;
};

const method = (channel: string, handler: (raw: unknown) => unknown | Promise<unknown>): DesktopIpcMethod<unknown, never> => ({
  channel,
  handler: (raw) => Effect.tryPromise({ try: () => Promise.resolve(handler(raw)), catch: (error) => error }),
});

export const previewMethods = [
  method(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, (raw) => previewViewManager.createTab(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, (raw) => previewViewManager.closeTab(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, (raw) => {
    const tabId = tabIdFrom(raw);
    const webContentsId = typeof raw === "object" && raw !== null && "webContentsId" in raw ? raw.webContentsId : null;
    if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId) || webContentsId <= 0) {
      throw new Error("preview webContentsId must be a positive integer");
    }
    return previewViewManager.registerWebview(tabId, webContentsId);
  }),
  method(IpcChannels.PREVIEW_NAVIGATE_CHANNEL, (raw) => {
    const tabId = tabIdFrom(raw);
    const url = typeof raw === "object" && raw !== null && "url" in raw ? raw.url : null;
    if (typeof url !== "string") throw new Error("preview url must be a string");
    return previewViewManager.navigate(tabId, url);
  }),
  method(IpcChannels.PREVIEW_GO_BACK_CHANNEL, (raw) => previewViewManager.goBack(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, (raw) => previewViewManager.goForward(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_REFRESH_CHANNEL, (raw) => previewViewManager.refresh(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, (raw) => previewViewManager.zoomIn(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, (raw) => previewViewManager.zoomOut(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, (raw) => previewViewManager.resetZoom(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, (raw) => previewViewManager.hardReload(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, (raw) => previewViewManager.openDevTools(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL, () => previewViewManager.clearCookies()),
  method(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL, () => previewViewManager.clearCache()),
  method(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, () => {
    const preloadPath = NodePath.join(__dirname, "preview-pick-preload.cjs");
    return {
      partition: previewViewManager.getBrowserPartition(),
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      preloadUrl: NodeFileSystem.existsSync(preloadPath) ? pathToFileURL(preloadPath).href : null,
    };
  }),
  method(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, (raw) =>
    previewViewManager.pickElement(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, (raw) =>
    previewViewManager.cancelPickElement(tabIdFrom(raw)),
  ),
] as const;
