import { useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { StandaloneStack } from "../nested-stacks";
import { pageRoute } from "../route-options";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceSidebarTabs } from "./WorkspaceSidebarTabs";
import { getCompactBrandHeaderOptions } from "./brand-header-options";

/** The iOS sidebar column hosts its own stack so it gets a native bar with the brand title. */
export function WorkspaceSidebarColumn(props: {
  readonly width: number;
  readonly children: ReactNode;
}) {
  const deviceType = useDeviceType();
  const workspace = useWorkspaceTabs();
  const m = useMessages();
  const options = {
    ...pageRoute(),
    ...getCompactBrandHeaderOptions({ fontSize: 18, fontWeight: "800" }, m),
  };
  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-border bg-drawer"
      style={{ borderRightWidth: StyleSheet.hairlineWidth, width: props.width }}
    >
      <StandaloneStack surface="sidebar" options={options}>
        {props.children}
      </StandaloneStack>
      {deviceType === "pad" && workspace !== null ? <WorkspaceSidebarTabs /> : null}
    </View>
  );
}
