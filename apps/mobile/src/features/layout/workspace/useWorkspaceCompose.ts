import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

/** What the compose button starts on the selected tab; null where the tab has nothing to start. */
export function useWorkspaceCompose() {
  const workspace = useWorkspaceTabs();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  if (!workspace || workspace.settingsOpen || workspace.state.selectedTab !== "threads")
    return null;
  return { label: "New chat", onPress: startNewTask } as const;
}
