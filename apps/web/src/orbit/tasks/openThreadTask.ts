import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";

import { openTaskPullRequest } from "./orbitAgentConversation";
import { tasksPanelActions } from "./tasksPanelStore";

/**
 * Opens the thread's Tasks tab, whatever tab or panel state it was in, on one task. With a PR
 * URL it opens that PR below the task, as the board's badge does; a PR no connected project can
 * open leaves the task open.
 */
export function openThreadTask(
  threadRef: ScopedThreadRef,
  taskId: number,
  pullRequestUrl?: string,
) {
  useRightPanelStore.getState().open(threadRef, "tasks");
  const threadKey = scopedThreadKey(threadRef);
  if (pullRequestUrl && openTaskPullRequest(threadKey, taskId, pullRequestUrl)) return;
  tasksPanelActions().openTask(threadKey, taskId);
}
