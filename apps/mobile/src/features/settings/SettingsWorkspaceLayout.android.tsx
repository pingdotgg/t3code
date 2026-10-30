import { NavigationRouteContext } from "@react-navigation/native";
import { Activity, useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useAndroidWorkspaceRoot } from "../workspace/AndroidWorkspaceTabsProvider";
import { SettingsListScreen } from "./SettingsRouteScreen";
import { SettingsScreen } from "./components/SettingsScreen";

const SETTINGS_LIST_ROUTE = { key: "settings-sidebar", name: "Settings" };

export function SettingsWorkspaceLayout(props: { readonly children: ReactNode }) {
  const root = useAndroidWorkspaceRoot();
  const { layout } = useAdaptiveWorkspaceLayout();
  const split = root?.settingsOpen === true && layout.usesSplitView;
  const [visited, setVisited] = useState(split);
  if (split && !visited) setVisited(true);
  const emptyDetail = split && root.settingsPage === null;
  const route = root?.settingsRoute ?? SETTINGS_LIST_ROUTE;

  return (
    <View className="flex-1 flex-row">
      {visited ? (
        <Activity mode={split ? "visible" : "hidden"}>
          <View style={{ width: layout.listPaneWidth ?? 0, marginRight: layout.listPaneGap ?? 0 }}>
            <NavigationRouteContext value={route}>
              <SettingsListScreen sidebar selected={root?.settingsPage ?? null} />
            </NavigationRouteContext>
          </View>
        </Activity>
      ) : null}
      {/* A push slides the page underneath to the left; keep it out of the list beside it. */}
      <View className="flex-1 overflow-hidden">
        <View
          className="flex-1"
          pointerEvents={emptyDetail ? "none" : "auto"}
          accessibilityElementsHidden={emptyDetail}
          importantForAccessibility={emptyDetail ? "no-hide-descendants" : "auto"}
          style={emptyDetail ? { opacity: 0 } : undefined}
        >
          {props.children}
        </View>
        {emptyDetail ? (
          <View className="absolute inset-0">
            <NavigationRouteContext value={route}>
              <SettingsScreen title="Settings" workspaceRoot>
                <View className="flex-1 items-center justify-center p-6">
                  <AppText className="text-foreground-muted">Select a setting</AppText>
                </View>
              </SettingsScreen>
            </NavigationRouteContext>
          </View>
        ) : null}
      </View>
    </View>
  );
}
