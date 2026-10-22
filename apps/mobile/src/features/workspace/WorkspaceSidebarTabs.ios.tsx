import { requireNativeView } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useControlTheme } from "../../components/ui/useControlTheme";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

const NativeSidebarTabBar = requireNativeView<
  ViewProps & {
    selectedIndex: number;
    selectedColor: string;
    appearance: string;
    onSelectionChange: (event: NativeSyntheticEvent<{ index: number }>) => void;
  }
>("T3NativeControls", "SidebarTabBar");

export function WorkspaceSidebarTabs() {
  const workspace = useWorkspaceTabs()!;
  const selectTab = useSelectWorkspaceTab();
  const insets = useSafeAreaInsets();
  const { colors, colorScheme } = useControlTheme();
  return (
    <NativeSidebarTabBar
      selectedIndex={workspace.state.selectedTab === "threads" ? 0 : 1}
      selectedColor={colors["--color-primary"]}
      appearance={colorScheme}
      onSelectionChange={({ nativeEvent }) =>
        selectTab(nativeEvent.index === 0 ? "threads" : "pullRequests")
      }
      style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 64 + insets.bottom }}
    />
  );
}
