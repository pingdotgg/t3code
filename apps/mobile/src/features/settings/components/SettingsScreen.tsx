import { useNavigation, useNavigationState, useRoute } from "@react-navigation/native";
import { use, type ReactNode } from "react";
import { Platform, View } from "react-native";

import type { AppBarProps } from "../../../components/ui/AppBar.types";
import { AppBar } from "../../../components/ui/AppBar";
import { ScreenContent as SettingsScreenContent } from "../../../components/ui/ScreenContent";
import { useWorkspaceTabs } from "../../workspace/WorkspaceTabsContext";
import { useWorkspaceSurface } from "../../workspace/useWorkspaceSurface";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useCompactWorkspaceTabs } from "../../workspace/useSystemWorkspaceTabBar";
import { ScreenScrollViewBottomInset } from "../../../components/ui/ScreenScrollView";
import { useAdaptiveWorkspaceLayout } from "../../layout/adaptive-workspace-context";
import { SettingsPaneContext } from "../settings-pane-context";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<AppBarProps, "title" | "actions" | "trailing"> & {
    readonly children: ReactNode;
    readonly formSheet?: boolean;
    readonly workspaceRoot?: boolean;
  },
) {
  const navigation = useNavigation();
  const route = useRoute();
  const index = useNavigationState((state) => state.index);
  const workspace = useWorkspaceTabs();
  const surface = useWorkspaceSurface();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const pane = use(SettingsPaneContext);
  const { layout } = useAdaptiveWorkspaceLayout();
  const cover = deviceType === "duo-folded";
  // Android opens Settings as a workspace tab; its root page has nothing to go back to.
  const workspaceRoot =
    props.workspaceRoot ||
    pane?.role === "list" ||
    (Platform.OS === "android" && workspace !== null && index === 0 && route.name === "Settings");

  return (
    <View
      collapsable={false}
      className={`flex-1 ${workspaceRoot || cover ? surface.className : "bg-sheet"}`}
    >
      <AppBar
        title={props.title}
        actions={props.actions}
        trailing={Platform.OS === "android" ? props.trailing : undefined}
        sidebar={false}
        onBack={workspaceRoot ? undefined : () => navigation.goBack()}
        hideBottomBorder={!props.formSheet}
      />
      {Platform.OS === "ios" && (workspaceRoot || cover) ? (
        <NativeStackScreenOptions
          options={{
            headerTransparent: false,
            headerStyle: { backgroundColor: surface.backgroundColor },
            contentStyle: { backgroundColor: surface.backgroundColor },
          }}
        />
      ) : null}
      <ScreenScrollViewBottomInset
        value={
          pane?.split && pane.role === "detail"
            ? 0
            : deviceType === "pad" || compactTabs || layout.primarySidebarOverlaysContent
              ? 80
              : 0
        }
      >
        {props.formSheet ? (
          props.children
        ) : (
          <SettingsScreenContent insetHorizontal={pane?.split}>
            {props.children}
          </SettingsScreenContent>
        )}
      </ScreenScrollViewBottomInset>
    </View>
  );
}
