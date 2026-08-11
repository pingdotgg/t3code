import type { DesktopPreviewBridge } from "@t3tools/contracts";

import type { PreviewAction } from "./previewActionBus";

type PreviewZoomBridge = Pick<DesktopPreviewBridge, "resetZoom" | "zoomIn" | "zoomOut">;

export function handlePreviewZoomAction(
  action: PreviewAction,
  bridge: PreviewZoomBridge,
  runtimeTabId: string,
): boolean {
  switch (action) {
    case "zoom-in":
      void bridge.zoomIn(runtimeTabId);
      return true;
    case "zoom-out":
      void bridge.zoomOut(runtimeTabId);
      return true;
    case "reset-zoom":
      void bridge.resetZoom(runtimeTabId);
      return true;
    case "focus-url":
    case "refresh":
    case "toggle-panel":
      return false;
  }
}
