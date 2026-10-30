import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";

let focusPending = false;
const focusListeners = new Set<() => void>();

/** Opening the coordinator tab on purpose focuses its composer; remounts from navigation do not. */
export function openPipelineCoordinator(stepThreadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().open(stepThreadRef, "pipeline-coordinator");
  if (focusListeners.size === 0) {
    focusPending = true;
    return;
  }
  for (const listener of focusListeners) listener();
}

export function subscribeEmbeddedComposerFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  if (focusPending) {
    focusPending = false;
    listener();
  }
  return () => {
    focusListeners.delete(listener);
  };
}
