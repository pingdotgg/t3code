import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { WORKSPACE_TAB_LABELS, useEnabledNavigationTabs } from "./navigation-tabs";
import { WorkspaceExtraTab } from "./WorkspaceExtraTab";
import { WorkspaceSectionToolbar } from "./WorkspaceSectionToolbar";
import { useNavigation } from "@react-navigation/native";
import { use, useCallback, useMemo } from "react";
import { Platform, View, useWindowDimensions } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { isDuoDevice } from "../../lib/device-type";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useWorkspaceSurface } from "./useWorkspaceSurface";
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
import {
  WORKSPACE_DOCK,
  workspaceSearchBottomClearance,
  workspaceDockBottomClearance,
  workspaceToolbarHeight,
} from "./workspace-tabs-state";
import { WorkspaceSidebarTabs } from "./WorkspaceSidebarTabs";
import {
  useCompactWorkspaceTabs,
  useSidebarWorkspaceTabs,
  useSystemWorkspaceTabBar,
} from "./useSystemWorkspaceTabBar";

const TAB_TITLES = WORKSPACE_TAB_LABELS;

function WorkspaceRootTitle(props: {
  readonly maxWidth: number;
  readonly onOpenEnvironments: () => void;
}) {
  const { state } = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  return (
    <View style={{ width: props.maxWidth, minHeight: 32, justifyContent: "center" }}>
      <WorkspaceConnectionTitle
        brand={
          <CompactBrandTitle
            accessibilityLabel={`T3 Code, ${enabled.length ? TAB_TITLES[state.selectedTab] : "Navigation"}`}
          />
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
  const surface = useWorkspaceSurface();
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
  const bottomBarInset = useDuoBottomBarInset();
  const keyboardHeight = useKeyboardState((keyboard) => keyboard.height);
  const workspace = useWorkspaceTabs()!;
  const { state } = workspace;
  const solidHeader = deviceType === "duo-folded" || state.selectedTab === "usage";
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
      ? workspaceSearchBottomClearance({
          bottomInset: insets.bottom,
          bottomBarInset,
          keyboardHeight,
        })
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
  const context = useMemo(() => ({ ...workspace, bottomClearance }), [workspace, bottomClearance]);

  return (
    <WorkspaceTabsContext value={context}>
      <View
        className={`flex-1 ${sidebarPicker ? "bg-drawer" : surface.className}`}
        style={sidebarPicker ? { paddingTop: insets.top } : undefined}
      >
        {Platform.OS === "ios" ? (
          <NativeStackScreenOptions
            optionsVersion={[
              state.selectedTab,
              state.selectionRevision,
              width,
              sidebarNavigation,
              enabled.length,
            ]}
            options={{
              title: enabled.length ? TAB_TITLES[state.selectedTab] : "Navigation",
              headerShown: true,
              headerTransparent: solidHeader ? false : NATIVE_LIQUID_GLASS_SUPPORTED,
              headerStyle: solidHeader
                ? { backgroundColor: surface.backgroundColor }
                : NATIVE_LIQUID_GLASS_SUPPORTED
                  ? { backgroundColor: "transparent" }
                  : undefined,
              contentStyle: solidHeader ? { backgroundColor: surface.backgroundColor } : undefined,
              ...(state.selectedTab !== "usage" || enabled.length === 0
                ? { headerRight: undefined }
                : {}),
              ...(enabled.length === 0
                ? { headerSearchBarOptions: undefined, unstable_headerRightItems: () => [] }
                : {}),
              unstable_headerLeftItems: () => [],
              headerTitle: state.selectedTab === "usage" ? undefined : renderHeaderTitle,
            }}
          />
        ) : (
          <AndroidScreenHeader
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
                onPress: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "Settings" },
                  }),
              },
            ]}
          />
        )}
        <SafeAreaInsetsContext
          value={
            sidebarPicker ? { ...insets, top: 0 } : compactTabs ? { ...insets, bottom: 0 } : insets
          }
        >
          {enabled.length === 0 ? (
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
        {enabled.length === 0 ? null : state.selectedTab === "threads" ||
          state.selectedTab === "pullRequests" ? (
          <WorkspaceToolbar sidebar={sidebarNavigation} onNewTask={startNewTask} />
        ) : (
          <WorkspaceSectionToolbar
            onNewTask={startNewTask}
            showCompose={state.selectedTab !== "usage"}
          />
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
