import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { StandaloneStack } from "../nested-stacks";
import { pageRoute } from "../route-options";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceSidebarTabs } from "./WorkspaceSidebarTabs";
import { getCompactBrandHeaderOptions } from "./brand-header-options";

const SIDEBAR_COLUMN_OPTIONS = {
  ...pageRoute(),
  ...getCompactBrandHeaderOptions({ fontSize: 18, fontWeight: "800" }),
};

/** The iOS sidebar column hosts its own stack so it gets a native bar with the brand title. */
export function WorkspaceSidebarColumn(props: {
  readonly width: number;
  readonly children: ReactNode;
}) {
  const deviceType = useDeviceType();
  const workspace = useWorkspaceTabs();
  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-border bg-drawer"
      style={{ borderRightWidth: StyleSheet.hairlineWidth, width: props.width }}
    >
      <StandaloneStack surface="sidebar" options={SIDEBAR_COLUMN_OPTIONS}>
        {props.children}
      </StandaloneStack>
      {/* Keep legacy iPad navigation in its sidebar; the detail host previously covered the composer.

          旧版 iPad 的导航跟随侧栏，避免此前挂在详情容器上遮挡输入框。 */}
      {deviceType === "pad" && workspace !== null ? <WorkspaceSidebarTabs /> : null}
    </View>
  );
}
