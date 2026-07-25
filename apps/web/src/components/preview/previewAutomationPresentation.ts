import type { ScopedThreadRef } from "@t3tools/contracts";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { setActivePreviewTab } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

export function revealPreviewAutomationTab(ref: ScopedThreadRef, tabId: string): void {
  setActivePreviewTab(ref, tabId);
  useRightPanelStore.getState().openBrowser(ref, tabId);
}

export function isPreviewAutomationTabPresented(ref: ScopedThreadRef, tabId: string): boolean {
  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  return (
    panel.isOpen &&
    panel.activeSurfaceId === `browser:${tabId}` &&
    (useBrowserSurfaceStore.getState().byTabId[tabId]?.visible ?? false)
  );
}
