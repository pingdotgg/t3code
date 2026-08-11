import type { ScopedThreadRef } from "@t3tools/contracts";

import { readThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

/** Keep automation-owned preview tabs recoverable from the thread's Browser surface. */
export function reconcilePreviewRightPanelSurfaces(threadRef: ScopedThreadRef): void {
  const tabIds = Object.keys(readThreadPreviewState(threadRef).sessions);
  useRightPanelStore.getState().reconcileBrowserSurfaces(threadRef, tabIds);
}
