import { useMemo } from "react";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useAdaptiveWorkspaceLayout } from "./AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "./native-glass-header-items";

export function useWorkspaceSidebarHeaderItem() {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const { panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  return useMemo(
    () =>
      withNativeGlassHeaderItem({
        axisBehavior: usesNativeWorkspaceColumns ? "horizontalOnly" : undefined,
        accessibilityLabel: panes.primarySidebarVisible
          ? "Maximize content"
          : "Show thread sidebar",
        icon: {
          name: panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
          type: "sfSymbol" as const,
        },
        identifier: "thread-left-sidebar",
        label: panes.primarySidebarVisible ? "Maximize content" : "Show thread sidebar",
        onPress: togglePrimarySidebar,
        type: "button" as const,
      }),
    [panes.primarySidebarVisible, togglePrimarySidebar, usesNativeWorkspaceColumns],
  );
}
