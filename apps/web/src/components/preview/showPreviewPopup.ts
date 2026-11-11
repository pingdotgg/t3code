import type { ScopedThreadRef } from "@t3tools/contracts";

import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { whenPreviewTabKnown } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

export function showPreviewPopup(
  threadRef: ScopedThreadRef,
  popupTabId: string,
  from: "panel" | "floating",
): void {
  whenPreviewTabKnown(threadRef, popupTabId, () => {
    if (from === "floating") {
      usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(popupTabId));
    } else {
      useRightPanelStore.getState().openBrowser(threadRef, popupTabId);
    }
  });
}
