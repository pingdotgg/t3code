// @effect-diagnostics nodeBuiltinImport:off
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { BrowserWindow } from "electron";
import { pathToFileURL } from "node:url";

import { previewViewManager } from "../../preview-view-manager.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../preview-webview-preferences.ts";
import * as IpcChannels from "../channels.ts";
import type { DesktopIpcMethod } from "../DesktopIpc.ts";

previewViewManager.onStateChange((tabId, state) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, tabId, state);
    }
  }
});

previewViewManager.onRecordingFrame((frame) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, frame);
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

const inputFrom = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || !("input" in raw)) {
    throw new Error("preview automation input is required");
  }
  return raw.input;
};

class PreviewIpcError extends Data.TaggedError("PreviewIpcError")<{
  readonly cause: unknown;
}> {}

const method = (
  channel: string,
  handler: (raw: unknown) => unknown | Promise<unknown>,
): DesktopIpcMethod<PreviewIpcError, never> => ({
  channel,
  handler: (raw) =>
    Effect.tryPromise({
      try: () => Promise.resolve(handler(raw)),
      catch: (cause) => new PreviewIpcError({ cause }),
    }),
});

export const previewMethods = [
  method(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, (raw) =>
    previewViewManager.createTab(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, (raw) =>
    previewViewManager.closeTab(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, (raw) => {
    const tabId = tabIdFrom(raw);
    const webContentsId =
      typeof raw === "object" && raw !== null && "webContentsId" in raw ? raw.webContentsId : null;
    if (
      typeof webContentsId !== "number" ||
      !Number.isInteger(webContentsId) ||
      webContentsId <= 0
    ) {
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
  method(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, (raw) =>
    previewViewManager.goForward(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_REFRESH_CHANNEL, (raw) => previewViewManager.refresh(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, (raw) => previewViewManager.zoomIn(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, (raw) => previewViewManager.zoomOut(tabIdFrom(raw))),
  method(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, (raw) =>
    previewViewManager.resetZoom(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, (raw) =>
    previewViewManager.hardReload(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, (raw) =>
    previewViewManager.openDevTools(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL, () => previewViewManager.clearCookies()),
  method(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL, () => previewViewManager.clearCache()),
  method(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, (raw) => {
    const environmentId =
      typeof raw === "object" && raw !== null && "environmentId" in raw ? raw.environmentId : null;
    if (typeof environmentId !== "string" || environmentId.length === 0) {
      throw new Error("preview environment id is required");
    }
    previewViewManager.getBrowserSession(environmentId);
    const preloadPath = `${__dirname}/preview-pick-preload.cjs`;
    return {
      partition: previewViewManager.getBrowserPartition(environmentId),
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      preloadUrl: pathToFileURL(preloadPath).href,
    };
  }),
  method(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, (raw) =>
    previewViewManager.pickElement(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, (raw) =>
    previewViewManager.cancelPickElement(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, (raw) =>
    previewViewManager.captureScreenshot(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL, (raw) =>
    previewViewManager.automationStatus(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL, (raw) =>
    previewViewManager.automationSnapshot(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL, (raw) =>
    previewViewManager.automationClick(
      tabIdFrom(raw),
      inputFrom(raw) as Parameters<typeof previewViewManager.automationClick>[1],
    ),
  ),
  method(IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL, (raw) =>
    previewViewManager.automationType(
      tabIdFrom(raw),
      inputFrom(raw) as Parameters<typeof previewViewManager.automationType>[1],
    ),
  ),
  method(IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL, (raw) =>
    previewViewManager.automationPress(
      tabIdFrom(raw),
      inputFrom(raw) as Parameters<typeof previewViewManager.automationPress>[1],
    ),
  ),
  method(IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL, (raw) =>
    previewViewManager.automationScroll(
      tabIdFrom(raw),
      inputFrom(raw) as Parameters<typeof previewViewManager.automationScroll>[1],
    ),
  ),
  method(IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL, (raw) =>
    previewViewManager.automationEvaluate(
      tabIdFrom(raw),
      inputFrom(raw) as Parameters<typeof previewViewManager.automationEvaluate>[1],
    ),
  ),
  method(IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL, (raw) =>
    previewViewManager.automationWaitFor(
      tabIdFrom(raw),
      inputFrom(raw) as Parameters<typeof previewViewManager.automationWaitFor>[1],
    ),
  ),
  method(IpcChannels.PREVIEW_RECORDING_START_CHANNEL, (raw) =>
    previewViewManager.startRecording(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL, (raw) =>
    previewViewManager.stopRecording(tabIdFrom(raw)),
  ),
  method(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL, (raw) => {
    const tabId = tabIdFrom(raw);
    if (typeof raw !== "object" || raw === null) throw new Error("recording payload is required");
    const mimeType = "mimeType" in raw ? raw.mimeType : null;
    const data = "data" in raw ? raw.data : null;
    if (typeof mimeType !== "string" || !(data instanceof Uint8Array)) {
      throw new Error("recording mimeType and bytes are required");
    }
    return previewViewManager.saveRecording(tabId, mimeType, data);
  }),
] as const;
