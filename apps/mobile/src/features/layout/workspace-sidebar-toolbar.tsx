import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { Platform } from "react-native";

import { useAdaptiveWorkspaceLayout } from "./AdaptiveWorkspaceLayout";

export function WorkspaceSidebarToolbar(props: { readonly children?: ReactNode } = {}) {
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();

  if (Platform.OS === "android" || !layout.usesSplitView) {
    return null;
  }

  return (
    <Stack.Toolbar placement="left">
      {props.children}
      <Stack.Toolbar.Button
        accessibilityLabel={
          panes.primarySidebarVisible ? "Maximize content" : "Show thread sidebar"
        }
        icon={panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"}
        onPress={togglePrimarySidebar}
        separateBackground
      />
    </Stack.Toolbar>
  );
}
