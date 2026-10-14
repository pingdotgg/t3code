import { useEffect } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRightPanelStore } from "../rightPanelStore";
import { requestWorkspaceContentFocus, requestWorkspaceFocus } from "../lib/workspaceFocus";

/** User panel choices hand focus to the committed surface; automatic openings remain passive. */
export function useWorkspacePanelFocus(threadRef: ScopedThreadRef | null) {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  useEffect(() => {
    if (!threadKey) return;
    return useRightPanelStore.subscribe((state, previous) => {
      const next = state.byThreadKey[threadKey];
      const before = previous.byThreadKey[threadKey];
      const panelOwnsFocus = Boolean(
        document.activeElement?.closest('[data-workspace-area="panel"]'),
      );
      if (!next?.isOpen) {
        if (before?.isOpen && panelOwnsFocus) requestWorkspaceContentFocus();
        return;
      }
      const userAction =
        state.userActionRevisionByThreadKey[threadKey] !==
        previous.userActionRevisionByThreadKey[threadKey];
      if (
        (!panelOwnsFocus || !before?.isOpen || next.activeSurfaceId !== before.activeSurfaceId) &&
        (userAction || panelOwnsFocus)
      ) {
        requestWorkspaceFocus({ area: "panel" });
      }
    });
  }, [threadKey]);
}
