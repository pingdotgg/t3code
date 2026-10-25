import { useCallback } from "react";
import { Keyboard } from "react-native";

import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

/** Opens a workspace tab, Settings included, from a tab bar, rail, toolbar or command. */
export function useSelectWorkspaceTab() {
  const dispatch = useWorkspaceTabs()?.dispatch;
  const { openWorkspaceTab } = useAdaptiveWorkspaceLayout();
  return useCallback(
    (tab: WorkspaceTab | "settings") => {
      Keyboard.dismiss();
      openWorkspaceTab(tab);
      if (tab !== "settings") dispatch?.({ type: "select", tab });
    },
    [dispatch, openWorkspaceTab],
  );
}
