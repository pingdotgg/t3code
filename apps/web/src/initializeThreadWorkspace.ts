import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "./rightPanelStore";
import {
  selectThreadWorkspaceDefault,
  useThreadWorkspaceDefaultStore,
} from "./threadWorkspaceDefaultStore";
import { useThreadWorkspaceLayoutStore } from "./threadWorkspaceLayoutStore";
import { createThreadWorkspaceTabFields } from "./threadWorkspaceTabs";

/** Copies the resolved default once. Later default edits never rewrite an existing thread. */
export function initializeNewThreadWorkspace(
  threadRef: ScopedThreadRef,
  logicalProjectKey: string,
): boolean {
  const threadKey = scopedThreadKey(threadRef);
  const layouts = useThreadWorkspaceLayoutStore.getState();

  if (threadKey in layouts.byThreadKey) return false;

  const template = selectThreadWorkspaceDefault(
    useThreadWorkspaceDefaultStore.getState(),
    logicalProjectKey,
  );
  useThreadWorkspaceLayoutStore.setState((state) => ({
    byThreadKey: {
      ...state.byThreadKey,
      [threadKey]: template?.layout ?? createThreadWorkspaceTabFields(),
    },
  }));

  if (template) {
    useRightPanelStore.setState((state) =>
      threadKey in state.byThreadKey
        ? state
        : {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: template.rightPanel,
            },
          },
    );
  }

  return true;
}
