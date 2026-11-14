import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";

// Docking hides the selected float; only explicit dismissal clears it.
export function closePreviewPanel(threadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().setMaximized(threadRef, false);
  useRightPanelStore.getState().close(threadRef);
}
