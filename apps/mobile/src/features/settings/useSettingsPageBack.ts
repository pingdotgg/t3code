import { useNavigation, useRoute } from "@react-navigation/native";
import { Platform } from "react-native";

import { resetAndroidWorkspace } from "../../lib/android-workspace-navigation";
import { useHardwareBack } from "../../lib/backHandler";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";

/**
 * The page's Back action. The first page beside the Settings list in a split roots the detail
 * column (`columnRoot`): Back there leaves Settings rather than emptying the column.
 */
export function useSettingsPageBack() {
  const navigation = useNavigation();
  const route = useRoute();
  const { layout } = useAdaptiveWorkspaceLayout();
  const routes = navigation.getState()?.routes ?? [];
  const below = routes[routes.findIndex((candidate) => candidate.key === route.key) - 1];
  const columnRoot = layout.usesSplitView && below?.name === "Settings";
  useHardwareBack(Platform.OS === "android" && columnRoot, () => {
    resetAndroidWorkspace(navigation);
    return true;
  });
  return { columnRoot, onBack: () => navigation.goBack() };
}
