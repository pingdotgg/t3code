import { useRoute } from "@react-navigation/native";
import { startTransition, useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";

import type { AppBarProps } from "../../../components/ui/AppBar.types";
import { AppBar } from "../../../components/ui/AppBar";
import { ScreenContent as SettingsScreenContent } from "../../../components/ui/ScreenContent";
import { useWorkspaceTabs } from "../../layout/workspace/WorkspaceTabsContext";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { useCompactWorkspaceTabs } from "../../layout/workspace/useSystemWorkspaceTabBar";
import { useSettingsPageBack } from "../useSettingsPageBack";
import {
  ScreenScrollViewBottomInset,
  ScreenScrollViewSurface,
} from "../../../components/ui/ScreenScrollView";

export { SettingsScreenContent };

/** Placeholder height so promoting the deferred body does not jump the scroll edge. */
function SettingsOpenShellBody() {
  return (
    <View className="gap-4 px-5 pt-4">
      <View className="bg-border/40 h-12 rounded-2xl" />
      <View className="bg-border/30 h-12 rounded-2xl" />
      <View className="bg-border/20 h-12 rounded-2xl" />
    </View>
  );
}

export function SettingsScreen(
  props: Pick<
    AppBarProps,
    "title" | "actions" | "refresh" | "trailing" | "search" | "menus" | "guardBack"
  > & {
    readonly children: ReactNode;
    readonly workspaceRoot?: boolean;
    /** When true, mount children on the first frame (page stages its own deferred work). */
    readonly eagerBody?: boolean;
  },
) {
  const route = useRoute();
  const workspace = useWorkspaceTabs();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const back = useSettingsPageBack();
  const cover = deviceType === "duo-folded";
  // Opened as a workspace tab, the Settings list has nothing to go back to.
  const workspaceRoot = props.workspaceRoot || (workspace !== null && route.name === "Settings");
  const [bodyReady, setBodyReady] = useState(props.eagerBody === true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- defers settings page body until after the push frame
  useEffect(() => {
    if (props.eagerBody) return;
    startTransition(() => {
      setBodyReady(true);
    });
  }, [props.eagerBody]);

  const surfaceClassName = workspaceRoot || cover ? "bg-screen" : "bg-sheet";

  return (
    <View collapsable={false} className={`flex-1 ${surfaceClassName}`}>
      <AppBar
        title={props.title}
        actions={props.actions}
        refresh={props.refresh}
        search={props.search}
        trailing={props.trailing}
        menus={props.menus}
        onBack={workspaceRoot ? undefined : back}
        guardBack={props.guardBack}
        hideBottomBorder
      />
      <ScreenScrollViewBottomInset value={deviceType === "pad" || compactTabs ? 80 : 0}>
        <ScreenScrollViewSurface value={surfaceClassName}>
          <SettingsScreenContent>
            {bodyReady ? props.children : <SettingsOpenShellBody />}
          </SettingsScreenContent>
        </ScreenScrollViewSurface>
      </ScreenScrollViewBottomInset>
    </View>
  );
}
