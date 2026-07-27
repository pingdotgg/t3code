// @effect-diagnostics globalDate:off - This isolated Electron preload does not run inside an Effect runtime.
import type { DesktopPreviewRecordingFrame } from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";

import { PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from "./ipc/channels.ts";

contextBridge.exposeInMainWorld("previewPictureInPicture", {
  onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
      if (typeof frame !== "object" || frame === null) return;
      listener(frame as DesktopPreviewRecordingFrame);
    };
    ipcRenderer.on(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, wrappedListener);
    return () =>
      ipcRenderer.removeListener(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, wrappedListener);
  },
});
