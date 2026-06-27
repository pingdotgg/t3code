import type { DesktopPreviewTabState, ScopedThreadRef } from "@t3tools/contracts";

import { applyPreviewDesktopState, type DesktopPreviewOverlay } from "~/previewStateStore";

import { previewBridge } from "./previewBridge";

export function projectDesktopPreviewState(state: DesktopPreviewTabState): DesktopPreviewOverlay {
  return {
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.navStatus.kind === "Loading",
    zoomFactor: state.zoomFactor,
    focused: state.focused,
    controller: state.controller,
  };
}

/**
 * Replay the authoritative native state. Automation cannot rely solely on a
 * React subscription because a newly-created tab may assign its WebContents
 * before that subscription mounts.
 */
export async function replayDesktopPreviewState(
  threadRef: ScopedThreadRef,
  tabId: string,
): Promise<DesktopPreviewTabState | null> {
  const state = await previewBridge?.getTabState(tabId);
  if (!state) return null;
  applyPreviewDesktopState(threadRef, tabId, projectDesktopPreviewState(state));
  return state;
}
