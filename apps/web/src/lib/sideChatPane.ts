import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";

import type { ToolCallDiffTarget } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";

/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}

/**
 * Opens an embedded side chat's tool diffs in its parent's diff panel. Other panel actions reach
 * the parent through `hostRightPanel`; diff selection lives in `diffPanelStore`, which it skips.
 */
export interface SideChatParentPanel {
  readonly openToolDiff: (target: ToolCallDiffTarget) => void;
}

/** Opens `thread` in its tab when it is a side chat of `parentRef`; false for any other thread. */
export function openSideChatTab(
  parentRef: ScopedThreadRef,
  thread: Pick<OrchestrationV2ThreadShell, "id" | "lineage"> | null,
): boolean {
  if (thread?.lineage.sideChat !== true || thread.lineage.parentThreadId !== parentRef.threadId) {
    return false;
  }
  useRightPanelStore.getState().openSideChat(parentRef, thread.id);
  return true;
}
