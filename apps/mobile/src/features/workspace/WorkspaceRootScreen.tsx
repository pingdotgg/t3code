import { useNavigation } from "@react-navigation/native";
import { use, useCallback, useMemo } from "react";
import { Platform, View, useWindowDimensions } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { isDuoDevice } from "../../lib/device-type";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import {
  useDeviceType,
  useDuoBottomBarInset,
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
import { WORKSPACE_DOCK, WORKSPACE_TOOLBAR, workspaceToolbarHeight } from "./workspace-tabs-state";
import { WorkspaceSidebarTabs } from "./WorkspaceSidebarTabs";
import { useSidebarWorkspaceTabs, useSystemWorkspaceTabBar } from "./useSystemWorkspaceTabBar";

const TAB_TITLES = {
  threads: "Threads",
  pullRequests: "Pull requests",
};

function WorkspaceRootTitle(props: {
  readonly maxWidth: number;
  readonly onOpenEnvironments: () => void;
}) {
  const { state } = useWorkspaceTabs()!;
  return (
    <View style={{ width: props.maxWidth, minHeight: 32, justifyContent: "center" }}>
      <WorkspaceConnectionTitle
        brand={
          <CompactBrandTitle accessibilityLabel={`T3 Code, ${TAB_TITLES[state.selectedTab]}`} />
        }
        maxWidth={props.maxWidth}
        onPress={props.onOpenEnvironments}
      />
    </View>
  );
}

function WorkspaceRootContent() {
  const navigation = useNavigation();
  const { width: windowWidth } = useWindowDimensions();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const primaryColumn = use(NativePrimaryColumnContext);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const nativeMetrics = useNativeLayoutMetrics();
  const deviceType = useDeviceType();
  const systemTabBar = useSystemWorkspaceTabBar();
  const sidebarTabs = useSidebarWorkspaceTabs();
  const sidebarPicker = sidebarTabs === "picker";
  const sidebarNavigation =
    primaryColumn !== null &&
    (layout.usesSplitView ||
      deviceType === "pad" ||
      (nativeMetrics !== null && nativeMetrics.verticalBarEdge !== "none"));
  const width = columnMetrics?.width ?? windowWidth;
  const insets = useSafeAreaInsets();
  const bottomBarInset = useDuoBottomBarInset();
  const keyboardHeight = useKeyboardState((keyboard) => keyboard.height);
  const workspace = useWorkspaceTabs()!;
  const { state } = workspace;
  const renderHeaderTitle = useCallback(
    () => (
      <WorkspaceRootTitle
        maxWidth={Math.max(0, width - 160)}
        onOpenEnvironments={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsEnvironments" },
          })
        }
      />
    ),
    [width, navigation],
  );
  const tab = state.tabs[state.selectedTab];
  const bottomClearance =
    Platform.OS === "ios" && isDuoDevice(deviceType)
      ? Math.max(bottomBarInset ?? Math.max(insets.bottom, 12), keyboardHeight + 8) +
        WORKSPACE_TOOLBAR.height +
        16
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
  const context = useMemo(() => ({ ...workspace, bottomClearance }), [workspace, bottomClearance]);

  return (
    <WorkspaceTabsContext value={context}>
      <View
        className={sidebarPicker ? "flex-1 bg-drawer" : "flex-1 bg-screen"}
        style={sidebarPicker ? { paddingTop: insets.top } : undefined}
      >
        {Platform.OS === "ios" ? (
          <NativeStackScreenOptions
            optionsVersion={[state.selectedTab, state.selectionRevision, width, sidebarNavigation]}
            options={{
              title: TAB_TITLES[state.selectedTab],
              headerShown: true,
              unstable_headerLeftItems: () => [],
              headerTitle: renderHeaderTitle,
            }}
          />
        ) : (
          <AndroidScreenHeader
            title="T3 Code"
            titleContent={renderHeaderTitle()}
            actions={[
              {
                accessibilityLabel:
                  state.selectedTab === "threads" ? "Search threads" : "Search pull requests",
                icon: "magnifyingglass",
                onPress: () => {
                  dispatchHardwareKeyboardCommand("focusSearch");
                },
              },
              {
                accessibilityLabel: "Settings",
                icon: "gearshape",
                onPress: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "Settings" },
                  }),
              },
            ]}
          />
        )}
        <SafeAreaInsetsContext value={sidebarPicker ? { ...insets, top: 0 } : insets}>
          {state.selectedTab === "threads" ? <HomeRouteScreen /> : <PullRequestsScreen />}
        </SafeAreaInsetsContext>
        {sidebarPicker ? <WorkspaceSidebarTabs /> : null}
        <WorkspaceToolbar sidebar={sidebarNavigation} onNewTask={startNewTask} />
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
