import { unwrapPreviewCaptureResult } from "./previewCaptureErrors";

const nativePreviewBridge =
  typeof window === "undefined" ? null : (window.desktopBridge?.preview ?? null);

export const previewBridge = nativePreviewBridge
  ? {
      ...nativePreviewBridge,
      captureScreenshot: async (tabId: string) =>
        unwrapPreviewCaptureResult(await nativePreviewBridge.captureScreenshot(tabId)),
      recording: {
        ...nativePreviewBridge.recording,
        startScreencast: async (tabId: string) =>
          unwrapPreviewCaptureResult(await nativePreviewBridge.recording.startScreencast(tabId)),
      },
    }
  : null;
