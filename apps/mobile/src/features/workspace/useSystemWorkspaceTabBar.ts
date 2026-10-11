import { Platform } from "react-native";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

export function useSidebarWorkspaceTabs() {
  const { layout } = useAdaptiveWorkspaceLayout();
  return Platform.OS === "ios" && Platform.isPad && layout.usesSplitView;
}

/** Compact iOS windows use UIKit tabs; wide iPad windows use the sidebar picker. */
export function useSystemWorkspaceTabBar() {
  const sidebarTabs = useSidebarWorkspaceTabs();
  return Platform.OS === "ios" && !sidebarTabs;
}
