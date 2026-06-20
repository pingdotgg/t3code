import {
  DesktopPreviewAnnotationThemeInputSchema,
  DesktopPreviewArtifactInputSchema,
  DesktopPreviewAutomationClickInputSchema,
  DesktopPreviewAutomationEvaluateInputSchema,
  DesktopPreviewAutomationPressInputSchema,
  DesktopPreviewAutomationScrollInputSchema,
  DesktopPreviewAutomationTypeInputSchema,
  DesktopPreviewAutomationWaitForInputSchema,
  DesktopPreviewConfigInputSchema,
  DesktopPreviewNavigateInputSchema,
  DesktopPreviewRecordingArtifactSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewRegisterWebviewInputSchema,
  DesktopPreviewScreenshotArtifactSchema,
  DesktopPreviewTabInputSchema,
  DesktopPreviewWebviewConfigSchema,
  PreviewAnnotationPayloadSchema,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
} from "@t3tools/contracts";
import { BrowserWindow } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { pathToFileURL } from "node:url";

import * as PreviewManager from "../../preview/Manager.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../preview/WebviewPreferences.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const broadcast = (channel: string, ...args: ReadonlyArray<unknown>): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  }
};

export const installPreviewEventForwarding = Effect.fn(
  "desktop.ipc.preview.installEventForwarding",
)(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  yield* manager.subscribeStateChanges((tabId, state) => {
    broadcast(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, tabId, state);
  });
  yield* manager.subscribeRecordingFrames((frame) => {
    broadcast(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, frame);
  });
  yield* manager.subscribePointerEvents((event) => {
    broadcast(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, event);
  });
});

export const createTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREATE_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.createTab")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.createTab(tabId);
  }),
});

export const closeTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.closeTab")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.closeTab(tabId);
  }),
});

export const registerWebview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL,
  payload: DesktopPreviewRegisterWebviewInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.registerWebview")(function* ({ tabId, webContentsId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.registerWebview(tabId, webContentsId);
  }),
});

export const navigate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_NAVIGATE_CHANNEL,
  payload: DesktopPreviewNavigateInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.navigate")(function* ({ tabId, url }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.navigate(tabId, url);
  }),
});

const tabMethod = (
  channel: string,
  name: string,
  invoke: (
    manager: PreviewManager.PreviewManagerShape,
    tabId: string,
  ) => Effect.Effect<void, PreviewManager.PreviewManagerError>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopPreviewTabInputSchema,
    result: Schema.Void,
    handler: Effect.fn(name)(function* ({ tabId }) {
      const manager = yield* PreviewManager.PreviewManager;
      yield* invoke(manager, tabId);
    }),
  });

export const goBack = tabMethod(
  IpcChannels.PREVIEW_GO_BACK_CHANNEL,
  "desktop.ipc.preview.goBack",
  (manager, tabId) => manager.goBack(tabId),
);
export const goForward = tabMethod(
  IpcChannels.PREVIEW_GO_FORWARD_CHANNEL,
  "desktop.ipc.preview.goForward",
  (manager, tabId) => manager.goForward(tabId),
);
export const refresh = tabMethod(
  IpcChannels.PREVIEW_REFRESH_CHANNEL,
  "desktop.ipc.preview.refresh",
  (manager, tabId) => manager.refresh(tabId),
);
export const zoomIn = tabMethod(
  IpcChannels.PREVIEW_ZOOM_IN_CHANNEL,
  "desktop.ipc.preview.zoomIn",
  (manager, tabId) => manager.zoomIn(tabId),
);
export const zoomOut = tabMethod(
  IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL,
  "desktop.ipc.preview.zoomOut",
  (manager, tabId) => manager.zoomOut(tabId),
);
export const resetZoom = tabMethod(
  IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL,
  "desktop.ipc.preview.resetZoom",
  (manager, tabId) => manager.resetZoom(tabId),
);
export const hardReload = tabMethod(
  IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL,
  "desktop.ipc.preview.hardReload",
  (manager, tabId) => manager.hardReload(tabId),
);
export const openDevTools = tabMethod(
  IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL,
  "desktop.ipc.preview.openDevTools",
  (manager, tabId) => manager.openDevTools(tabId),
);
export const cancelPickElement = tabMethod(
  IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL,
  "desktop.ipc.preview.cancelPickElement",
  (manager, tabId) => manager.cancelPickElement(tabId),
);
export const startRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_START_CHANNEL,
  "desktop.ipc.preview.startRecording",
  (manager, tabId) => manager.startRecording(tabId),
);
export const stopRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL,
  "desktop.ipc.preview.stopRecording",
  (manager, tabId) => manager.stopRecording(tabId),
);

export const clearCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCookies")(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCookies();
  }),
});

export const clearCache = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCache")(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCache();
  }),
});

export const getPreviewConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_CONFIG_CHANNEL,
  payload: DesktopPreviewConfigInputSchema,
  result: DesktopPreviewWebviewConfigSchema,
  handler: Effect.fn("desktop.ipc.preview.getConfig")(function* ({ environmentId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.getBrowserSession(environmentId);
    return {
      partition: yield* manager.getBrowserPartition(environmentId),
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      preloadUrl: pathToFileURL(`${__dirname}/preview-pick-preload.cjs`).href,
    };
  }),
});

export const setAnnotationTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
  payload: DesktopPreviewAnnotationThemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationTheme")(function* ({ theme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAnnotationTheme(theme);
  }),
});

export const pickElement = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(PreviewAnnotationPayloadSchema),
  handler: Effect.fn("desktop.ipc.preview.pickElement")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.pickElement(tabId);
  }),
});

export const captureScreenshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewScreenshotArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.captureScreenshot")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.captureScreenshot(tabId);
  }),
});

export const revealArtifact = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.revealArtifact")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.revealArtifact(path);
  }),
});

export const copyArtifactToClipboard = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.copyArtifactToClipboard")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.copyArtifactToClipboard(path);
  }),
});

export const automationStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: PreviewAutomationStatus,
  handler: Effect.fn("desktop.ipc.preview.automationStatus")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationStatus(tabId);
  }),
});

export const automationSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: PreviewAutomationSnapshot,
  handler: Effect.fn("desktop.ipc.preview.automationSnapshot")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationSnapshot(tabId);
  }),
});

export const automationClick = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL,
  payload: DesktopPreviewAutomationClickInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationClick")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationClick(tabId, input);
  }),
});

export const automationType = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL,
  payload: DesktopPreviewAutomationTypeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationType")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationType(tabId, input);
  }),
});

export const automationPress = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL,
  payload: DesktopPreviewAutomationPressInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationPress")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationPress(tabId, input);
  }),
});

export const automationScroll = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL,
  payload: DesktopPreviewAutomationScrollInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationScroll")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationScroll(tabId, input);
  }),
});

export const automationEvaluate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
  payload: DesktopPreviewAutomationEvaluateInputSchema,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.preview.automationEvaluate")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationEvaluate(tabId, input);
  }),
});

export const automationWaitFor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL,
  payload: DesktopPreviewAutomationWaitForInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationWaitFor")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationWaitFor(tabId, input);
  }),
});

export const saveRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL,
  payload: DesktopPreviewRecordingSaveInputSchema,
  result: DesktopPreviewRecordingArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.saveRecording")(function* ({ tabId, mimeType, data }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.saveRecording(tabId, mimeType, data);
  }),
});

export const methods = [
  createTab,
  closeTab,
  registerWebview,
  navigate,
  goBack,
  goForward,
  refresh,
  zoomIn,
  zoomOut,
  resetZoom,
  hardReload,
  openDevTools,
  clearCookies,
  clearCache,
  getPreviewConfig,
  setAnnotationTheme,
  pickElement,
  cancelPickElement,
  captureScreenshot,
  revealArtifact,
  copyArtifactToClipboard,
  automationStatus,
  automationSnapshot,
  automationClick,
  automationType,
  automationPress,
  automationScroll,
  automationEvaluate,
  automationWaitFor,
  startRecording,
  stopRecording,
  saveRecording,
] as const;
