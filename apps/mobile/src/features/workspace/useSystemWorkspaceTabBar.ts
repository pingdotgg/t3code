import { Platform } from "react-native";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useDeviceType, useNativeLayoutMetrics } from "../../native/native-layout-metrics";

export function useSidebarWorkspaceTabs(): "picker" | "toolbar" | null {
  const { layout } = useAdaptiveWorkspaceLayout();
  const deviceType = useDeviceType();
  const metrics = useNativeLayoutMetrics();
  if (Platform.OS !== "ios" || !layout.usesSplitView) return null;
  if (deviceType === "pad") return "picker";
  // Duo tabs use the side rail; unfolded portrait lacks one and uses the list toolbar.
  return (metrics?.verticalBarEdge ?? "none") === "none" ? "toolbar" : null;
}

export function useSystemWorkspaceTabBar() {
  const sidebarTabs = useSidebarWorkspaceTabs();
  return Platform.OS === "ios" && sidebarTabs === null;
}
