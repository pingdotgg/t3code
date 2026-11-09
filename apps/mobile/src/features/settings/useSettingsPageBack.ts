import { useNavigation, useRoute } from "@react-navigation/native";
import { Platform } from "react-native";

import { resetAndroidWorkspace } from "../../lib/android-workspace-navigation";
import { useHardwareBack } from "../../lib/backHandler";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";

/** The first Settings detail roots its column; nested pages can navigate back within it.
 *
 * 设置首个详情页为右列根页，后续子页才可在列内返回。
 */
export function useSettingsPageBack() {
  const navigation = useNavigation();
  const route = useRoute();
  const { layout } = useAdaptiveWorkspaceLayout();
  const routes = navigation.getState()?.routes ?? [];
  const below = routes[routes.findIndex((candidate) => candidate.key === route.key) - 1];
  // The first detail page roots either split layout; Back must not duplicate the sidebar list.
  //
  // 两种分栏的首个设置页均为详情根页，避免返回后在右列重复显示左侧目录。
  const columnRoot = layout.usesSplitView && below?.name === "Settings";
  useHardwareBack(Platform.OS === "android" && columnRoot, () => {
    resetAndroidWorkspace(navigation);
    return true;
  });
  return { columnRoot, onBack: () => navigation.goBack() };
}
