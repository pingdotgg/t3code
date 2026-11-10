import { usePaneRole } from "../../components/ui/Pane";
import { useAdaptiveWorkspaceLayout, useWorkspacePaneState } from "./adaptive-workspace-context";

/** The content pane's sidebar button, or null where there's no sidebar beside it to toggle. */
export function useSidebarToggle() {
  const role = usePaneRole();
  const { layout, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const { panes, sidebarToggleable } = useWorkspacePaneState();
  if (role !== "content" || !sidebarToggleable) return null;
  const maximizes = panes.primarySidebarVisible && layout.variant !== "medium";
  return {
    visible: panes.primarySidebarVisible,
    accessibilityLabel: panes.primarySidebarVisible
      ? maximizes
        ? "Maximize content"
        : "Hide sidebar"
      : "Show sidebar",
    icon: maximizes ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
    onPress: togglePrimarySidebar,
  } as const;
}
