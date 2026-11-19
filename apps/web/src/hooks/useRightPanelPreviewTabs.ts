import type { ScopedThreadRef } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { usePreviewTabs } from "../previewStateStore";
import { selectBrowserTabOwnerIds, useRightPanelStore } from "../rightPanelStore";

/** The preview sessions behind every browser tab in `threadRef`'s panel, whoever owns them. */
export function useRightPanelPreviewTabs(threadRef: ScopedThreadRef | null) {
  const ownerIds = useRightPanelStore(
    useShallow((state) => selectBrowserTabOwnerIds(state.byThreadKey, threadRef)),
  );
  return usePreviewTabs(threadRef, ownerIds);
}
