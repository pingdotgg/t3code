import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";

import type { ToolCallDiffTarget } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";

/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}

/**
 * Opens an embedded side chat's tool diffs in its parent's diff panel and runs its shell commands
 * in the parent's terminal drawer, since the embedded view hides its own. Other panel actions reach
 * the parent through `hostRightPanel`; diff selection and the drawer are not panel state.
 */
export interface SideChatParentPanel {
  readonly openToolDiff: (target: ToolCallDiffTarget) => void;
  readonly runShellCommand: (command: string) => void;
}

/**
 * Where opening `threadRef` should route. A side chat shows as a tab of its parent, so this opens
 * that tab and returns the parent; any other thread returns `threadRef`.
 */
export function resolveThreadOpenRoute(
  threadRef: ScopedThreadRef,
  thread: Pick<OrchestrationV2ThreadShell, "lineage"> | null,
): ScopedThreadRef {
  const parentThreadId = thread?.lineage.sideChat === true ? thread.lineage.parentThreadId : null;
  if (parentThreadId === null) return threadRef;
  const parentRef = scopeThreadRef(threadRef.environmentId, parentThreadId);
  useRightPanelStore.getState().openSideChat(parentRef, threadRef.threadId);
  return parentRef;
}
