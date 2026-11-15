import { useNavigation } from "@react-navigation/native";

import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

/** What the compose button starts on the selected tab; null where the tab has nothing to start. */
export function useWorkspaceCompose() {
  const workspace = useWorkspaceTabs();
  const navigation = useNavigation();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  if (!workspace || workspace.settingsOpen) return null;
  switch (workspace.state.selectedTab) {
    case "threads":
      return { tab: "threads", label: "New chat", onPress: startNewTask } as const;
    case "issues":
      return {
        tab: "issues",
        label: "New issue",
        onPress: () => navigation.navigate("IssueCreate"),
      } as const;
    default:
      return null;
  }
}
