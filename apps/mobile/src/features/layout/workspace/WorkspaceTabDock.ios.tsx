import { selectedNavigationTab, visibleNavigationTabs } from "./navigation-tab-order";
import { requireNativeView } from "expo";
import { View, useWindowDimensions, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { useControlTheme } from "../../../components/ui/useControlTheme";
import { nativeSidebarColumnWidth } from "../../../lib/layout";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { useNavigationTabOrder, useHiddenNavigationTabs } from "./navigation-tabs";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useFloatingWorkspaceTabs } from "./useSystemWorkspaceTabBar";
import { useWorkspaceCompose } from "./useWorkspaceCompose";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";

const NativeSidebarTabBar = requireNativeView<
  ViewProps & {
    tabs: readonly string[];
    selectedTab: string;
    selectedColor: string;
    appearance: string;
    showsCompose: boolean;
    compact?: boolean;
    onSelectionChange: (event: NativeSyntheticEvent<{ tab: string }>) => void;
    onCompose: () => void;
  }
>("T3NativeControls", "SidebarTabBar");

/**
 * The workspace tab bar wherever it's drawn. A sidebar column hosts it so it slides with the
 * column; over a page the window hosts it at the column's width, so both draw the same bar.
 */
export function WorkspaceTabDock(props: { readonly placement: "column" | "window" }) {
  const workspace = useWorkspaceTabs()!;
  const { layout } = useAdaptiveWorkspaceLayout();
  const deviceType = useDeviceType();
  const { width: windowWidth } = useWindowDimensions();
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const tabs = [...visibleNavigationTabs(order, hidden), "settings" as const];
  const selectTab = useSelectWorkspaceTab();
  const { colors, colorScheme } = useControlTheme();
  const compose = useWorkspaceCompose();
  // Floating tabs carry compose beside them, and keep its room when it's gone so the tabs hold still.
  const compact = useFloatingWorkspaceTabs();
  const onCompose = compact ? compose?.onPress : undefined;
  const width =
    props.placement === "column"
      ? undefined
      : deviceType === "pad" && compact
        ? Math.min(280, windowWidth)
        : layout.usesSplitView
          ? nativeSidebarColumnWidth(layout)
          : windowWidth;
  // UIKit loses accessible names when updating nil-titled items in place.
  const tabBarKey = tabs.join(":");
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        height: 128,
        ...(width === undefined ? { right: 0 } : { width }),
      }}
    >
      <NativeSidebarTabBar
        key={tabBarKey}
        tabs={tabs}
        selectedTab={selectedNavigationTab(
          order,
          workspace.state.selectedTab,
          workspace.settingsOpen,
          hidden,
        )}
        selectedColor={colors["--color-primary"]}
        appearance={colorScheme}
        showsCompose={onCompose !== undefined}
        compact={compact}
        onCompose={() => onCompose?.()}
        onSelectionChange={({ nativeEvent }) => {
          const tab = tabs.find((candidate) => candidate === nativeEvent.tab);
          if (tab) selectTab(tab);
        }}
        // Keep the host stable while UIKit updates the bars' intrinsic size and safe area together.
        style={{
          position: "absolute",
          bottom: 0,
          left: compact ? 8 : 0,
          maxWidth: layout.variant === "medium" ? 280 : undefined,
          right: compact ? 12 + (onCompose ? 0 : 64) : 0,
          height: 128,
        }}
      />
    </View>
  );
}
