import type { ScopedThreadRef } from "@t3tools/contracts";

import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { whenPreviewTabKnown } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

/**
 * Switches the viewer to a tab the page they drive just opened, as a browser
 * does for a link click or `window.open`. A floating opener floats the popup;
 * otherwise it becomes the panel's active tab. The opener stays open.
 */
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
