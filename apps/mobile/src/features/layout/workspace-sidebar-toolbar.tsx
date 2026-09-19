import { Platform } from "react-native";

import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";

import { useAdaptiveWorkspaceLayout } from "./AdaptiveWorkspaceLayout";

export function AndroidWorkspaceSidebarButton() {
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  if (Platform.OS !== "android" || !layout.usesSplitView) return null;

  return (
    <AndroidHeaderIconButton
      accessibilityLabel={
        panes.primarySidebarVisible ? "Hide thread sidebar" : "Show thread sidebar"
      }
      icon="sidebar.left"
      selected={panes.primarySidebarVisible}
      onPress={togglePrimarySidebar}
    />
  );
}
