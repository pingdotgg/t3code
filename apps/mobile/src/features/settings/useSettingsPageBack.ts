import { useNavigation, useRoute } from "@react-navigation/native";
import { Platform } from "react-native";

import { resetAndroidWorkspace } from "../../lib/android-workspace-navigation";
import { useHardwareBack } from "../../lib/backHandler";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";

/**
 * The page's Back action, or undefined for the first page beside the Settings list on wide
 * Android: that page roots the detail column, so Back leaves Settings rather than emptying it.
 */
export function useSettingsPageBack() {
  const navigation = useNavigation();
  const route = useRoute();
  const { layout } = useAdaptiveWorkspaceLayout();
  const routes = navigation.getState()?.routes ?? [];
  const below = routes[routes.findIndex((candidate) => candidate.key === route.key) - 1];
  const columnRoot =
    Platform.OS === "android" && layout.usesSplitView && below?.name === "Settings";
  useHardwareBack(columnRoot, () => {
    resetAndroidWorkspace(navigation);
    return true;
  });
  return columnRoot ? undefined : () => navigation.goBack();
}
