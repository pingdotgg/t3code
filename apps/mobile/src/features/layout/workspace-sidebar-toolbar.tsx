import { NativeHeaderToolbar } from "../../native/StackHeader";
import type { ReactNode } from "react";
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

export function WorkspaceSidebarToolbar(
  props: {
    readonly children?: ReactNode;
    readonly afterSidebarButton?: ReactNode;
  } = {},
) {
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();

  if (Platform.OS === "android" || !layout.usesSplitView) {
    return null;
  }

  return (
    <NativeHeaderToolbar placement="left">
      {props.children}
      <NativeHeaderToolbar.Button
        accessibilityLabel={
          panes.primarySidebarVisible ? "Maximize content" : "Show thread sidebar"
        }
        icon={panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"}
        onPress={togglePrimarySidebar}
      />
      {props.afterSidebarButton}
    </NativeHeaderToolbar>
  );
}
