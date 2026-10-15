import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { androidWorkspaceNavigationColors } from "./android-workspace-navigation-colors";
import { useSelectAndroidWorkspaceTab } from "./useAndroidWorkspaceSelection";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

const TABS = [
  { tab: "threads", label: "Chats", icon: "bubble.left" },
  { tab: "pullRequests", label: "Pull requests", icon: "arrow.triangle.pull" },
] as const satisfies ReadonlyArray<{ tab: WorkspaceTab; label: string; icon: string }>;

/** Chats/PRs switch that takes the brand slot in Android list headers. */
export function AndroidWorkspaceTabSwitch() {
  const workspace = useWorkspaceTabs();
  const selectTab = useSelectAndroidWorkspaceTab();
  const { themeVariables } = useAppearancePreferences();
  const { buttonSize, iconSize, scale } = useAndroidControlSizing();
  const colors = androidWorkspaceNavigationColors(themeVariables);
  if (workspace === null) return null;
  const segmentHeight = Math.round(32 * Math.max(1, scale));

  return (
    <View accessibilityRole="tablist" className="flex-row items-center">
      {TABS.map(({ tab, label, icon }) => {
        const selected = workspace.state.selectedTab === tab;
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            onPress={() => selectTab(tab)}
            className="items-center justify-center"
            style={{ width: buttonSize, height: buttonSize }}
          >
            <View
              className="items-center justify-center"
              style={{
                width: buttonSize - 4,
                height: segmentHeight,
                borderRadius: segmentHeight / 2,
                backgroundColor: selected ? colors.indicatorColor : "transparent",
              }}
            >
              <SymbolView
                name={icon}
                size={iconSize}
                tintColor={selected ? colors.selectedColor : colors.unselectedColor}
                type="monochrome"
              />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
