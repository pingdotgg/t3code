import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { WORKSPACE_TAB_LABELS, useEnabledNavigationTabs } from "./navigation-tabs";
import { WorkspaceExtraTab } from "./WorkspaceExtraTab";
import { SettingsRouteScreen } from "../settings/SettingsRouteScreen";
import { WorkspaceSectionToolbar } from "./WorkspaceSectionToolbar";
import { useNavigation } from "@react-navigation/native";
import { use } from "react";
import { Platform, View, useWindowDimensions } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { AppBar } from "../../components/ui/AppBar";
import { HeaderItemsWidthContext } from "../../native/header-items-width";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { isDuoDevice } from "../../lib/device-type";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import {
  useDeviceType,
  useNativeColumnLayoutMetrics,
  useNativeLayoutMetrics,
} from "../../native/native-layout-metrics";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { dispatchHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import {
  WorkspaceTabsContext,
  WorkspaceTabsProvider,
  useWorkspaceTabs,
} from "./WorkspaceTabsContext";
import { WorkspaceToolbar } from "./WorkspaceToolbar";
import {
  WORKSPACE_DOCK,
  workspaceDockBottomClearance,
  workspaceToolbarHeight,
} from "./workspace-tabs-state";
import { WorkspaceSidebarTabs } from "./WorkspaceSidebarTabs";
import {
  useCompactWorkspaceTabs,
  useSidebarWorkspaceTabs,
  useSystemWorkspaceTabBar,
} from "./useSystemWorkspaceTabBar";
import { openSettings } from "../settings/settings-navigation";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

const TAB_TITLES = WORKSPACE_TAB_LABELS;

function WorkspaceRootTitle(props: {
  readonly columnWidth: number;
  readonly onOpenEnvironments: () => void;
}) {
  const { state, settingsOpen } = useWorkspaceTabs()!;
  const maxWidth = Math.max(0, props.columnWidth - (use(HeaderItemsWidthContext) ?? 160));
  const enabled = useEnabledNavigationTabs();
  const tabTitle = settingsOpen
    ? "Settings"
    : enabled.length
      ? TAB_TITLES[state.selectedTab]
      : "Navigation";
  return (
    <View style={{ width: maxWidth, minHeight: 32, justifyContent: "center" }}>
      <WorkspaceConnectionTitle
        brand={<CompactBrandTitle accessibilityLabel={`T3 Code, ${tabTitle}`} fit />}
        maxWidth={maxWidth}
        onPress={props.onOpenEnvironments}
      />
    </View>
  );
}

function WorkspaceRootContent() {
  const navigation = useNavigation();
  const selectTab = useSelectWorkspaceTab();
  const { width: windowWidth } = useWindowDimensions();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const primaryColumn = use(NativePrimaryColumnContext);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const nativeMetrics = useNativeLayoutMetrics();
  const deviceType = useDeviceType();
  const systemTabBar = useSystemWorkspaceTabBar();
  const compactTabs = useCompactWorkspaceTabs();
  const enabled = useEnabledNavigationTabs();
  const sidebarTabs = useSidebarWorkspaceTabs();
  const sidebarPicker = sidebarTabs === "picker" || (deviceType === "pad" && layout.usesSplitView);
  const sidebarNavigation =
    primaryColumn !== null &&
    (layout.usesSplitView ||
      deviceType === "pad" ||
      (nativeMetrics !== null && nativeMetrics.verticalBarEdge !== "none"));
  const width = columnMetrics?.width ?? windowWidth;
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardState((keyboard) => keyboard.height);
  const workspace = useWorkspaceTabs()!;
  const { state } = workspace;
  // Settings is a workspace tab too; its list takes the place of the selected tab's.
  const settingsOpen = workspace.settingsOpen;
  const renderHeaderTitle = () => (
    <WorkspaceRootTitle
      columnWidth={width}
      onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
    />
  );
  const tab = state.tabs[settingsOpen ? "settings" : state.selectedTab];
  const bottomClearance =
    layout.variant === "medium" && state.selectedTab === "usage"
      ? workspaceDockBottomClearance({ bottomInset: insets.bottom, keyboardHeight })
      : Platform.OS === "ios" && isDuoDevice(deviceType)
        ? // The column's safe area already holds the Duo's search toolbar and keyboard.
          Math.max(insets.bottom, keyboardHeight) + 16
        : compactTabs || deviceType === "pad"
          ? workspaceDockBottomClearance({ bottomInset: insets.bottom, keyboardHeight })
          : Platform.OS === "ios"
            ? Math.max(insets.bottom, keyboardHeight) +
              (systemTabBar || sidebarTabs || tab.searchMode !== "resting"
                ? sidebarPicker
                  ? 80
                  : 16
                : WORKSPACE_DOCK.height + WORKSPACE_DOCK.bottomGap + 16)
            : keyboardHeight > 0 && tab.searchMode !== "resting"
              ? keyboardHeight + 64
              : Math.max(insets.bottom, 12) + workspaceToolbarHeight(tab.searchMode) + 16;
  const context = { ...workspace, bottomClearance };

  return (
    <WorkspaceTabsContext value={context}>
      <View className={sidebarPicker ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
        {Platform.OS === "ios" ? (
          <NativeStackScreenOptions
            optionsVersion={[
              settingsOpen,
              state.selectedTab,
              state.selectionRevision,
              width,
              sidebarNavigation,
              enabled.length,
            ]}
            options={{
              title: settingsOpen
                ? "Settings"
                : enabled.length
                  ? TAB_TITLES[state.selectedTab]
                  : "Navigation",
              headerShown: true,
              headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
              headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED
                ? { backgroundColor: "transparent" }
                : undefined,
              contentStyle: undefined,
              ...(enabled.length === 0
                ? { headerSearchBarOptions: undefined, unstable_headerRightItems: () => [] }
                : {}),
              unstable_headerLeftItems: () => [],
              // Beside a detail column the tab bar names the tab and the detail header the page,
              // so the sidebar keeps the brand.
              headerTitle:
                sidebarNavigation || (!settingsOpen && state.selectedTab !== "usage")
                  ? renderHeaderTitle
                  : undefined,
            }}
          />
        ) : (
          <AppBar
            embedded
            title="T3 Code"
            titleContent={renderHeaderTitle()}
            actions={[
              ...(state.selectedTab === "threads" || state.selectedTab === "pullRequests"
                ? [
                    {
                      accessibilityLabel:
                        state.selectedTab === "threads" ? "Search threads" : "Search pull requests",
                      icon: "magnifyingglass" as const,
                      onPress: () => {
                        dispatchHardwareKeyboardCommand("focusSearch");
                      },
                    },
                  ]
                : []),
              {
                accessibilityLabel: "Settings",
                icon: "gearshape",
                onPress: () => selectTab("settings"),
              },
            ]}
          />
        )}
        <SafeAreaInsetsContext value={compactTabs ? { ...insets, bottom: 0 } : insets}>
          {settingsOpen ? (
            <SettingsRouteScreen />
          ) : enabled.length === 0 ? (
            <WorkspaceNoTabs />
          ) : state.selectedTab === "threads" ? (
            <HomeRouteScreen />
          ) : state.selectedTab === "pullRequests" ? (
            <PullRequestsScreen />
          ) : (
            <WorkspaceExtraTab tab={state.selectedTab} />
          )}
        </SafeAreaInsetsContext>
        {deviceType !== "pad" && deviceType !== "phone" && sidebarPicker ? (
          <WorkspaceSidebarTabs />
        ) : null}
        {/* Android's Settings list carries its own search in its app bar. */}
        {enabled.length === 0 && !settingsOpen ? null : (
            settingsOpen
              ? Platform.OS === "ios"
              : state.selectedTab === "threads" || state.selectedTab === "pullRequests"
          ) ? (
          <WorkspaceToolbar sidebar={sidebarNavigation} onNewTask={startNewTask} />
        ) : (
          <WorkspaceSectionToolbar onNewTask={startNewTask} showCompose={false} />
        )}
      </View>
    </WorkspaceTabsContext>
  );
}

export function WorkspaceRootScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs();
  return Platform.OS === "android" && layout.usesSplitView ? (
    <HomeRouteScreen />
  ) : workspace ? (
    <WorkspaceRootContent />
  ) : (
    <WorkspaceTabsProvider>
      <WorkspaceRootContent />
    </WorkspaceTabsProvider>
  );
}
