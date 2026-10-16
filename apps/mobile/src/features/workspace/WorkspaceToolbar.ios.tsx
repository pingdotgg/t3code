import { Toolbar } from "../../components/ui/Toolbar";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { use, useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useDeviceType, useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import type { SearchBarCommands } from "react-native-screens";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useSidebarWorkspaceTabs } from "./useSystemWorkspaceTabBar";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";

// Tabler's git-pull-request geometry, shared with the UIKit tab bar.
const PULL_REQUEST_ICON = require("../../../assets/icons/pull-request.png");

export function WorkspaceToolbar(props: {
  readonly onNewTask: () => void;
  readonly sidebar?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  const metrics = useNativeLayoutMetrics();
  const deviceType = useDeviceType();
  const sidebarTabs = useSidebarWorkspaceTabs();
  const selectTab = useSelectWorkspaceTab();
  const selectedTint = useMobileNavigationTheme().colors.primary;
  const nativeToolbarCompose =
    Platform.OS === "ios" &&
    (deviceType === "pad" ||
      sidebarTabs !== null ||
      (metrics?.verticalBarEdge ?? "none") !== "none");
  const { isTabActive } = workspace;
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const { panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const searchRef = useRef<SearchBarCommands>(null);
  const tab = workspace.state.tabs[workspace.state.selectedTab];
  const selectedTab = workspace.state.selectedTab;
  const enterSearch = useCallback(() => {
    workspace.dispatch({
      type: "scroll",
      tab: selectedTab,
      offset: workspace.getScrollOffset(selectedTab),
    });
    workspace.dispatch({ type: "search", tab: selectedTab });
    if (props.sidebar && !panes.primarySidebarVisible) togglePrimarySidebar();
  }, [workspace, selectedTab, props.sidebar, panes.primarySidebarVisible, togglePrimarySidebar]);
  const focusSearch = useCallback(() => {
    if (!workspace.isTabActive(selectedTab)) return false;
    if (!NATIVE_LIQUID_GLASS_SUPPORTED) enterSearch();
    searchRef.current?.focus();
    return true;
  }, [workspace, selectedTab, enterSearch]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const restoreSearch = useCallback(() => {
    if (isTabActive(selectedTab) && tab.searchMode !== "resting")
      searchRef.current?.setText(tab.query);
  }, [isTabActive, selectedTab, tab.searchMode, tab.query]);
  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(restoreSearch);
      return () => cancelAnimationFrame(frame);
    }, [restoreSearch]),
  );
  useEffect(() => {
    if (!tabActive) return;
    const frame = requestAnimationFrame(restoreSearch);
    return () => cancelAnimationFrame(frame);
  }, [restoreSearch, tabActive]);
  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[selectedTab, tab.searchMode]}
        options={{
          // Liquid Glass keeps search mounted as UIKit's own header button, which
          // morphs into the field; swapping a stacked bar in and out cannot animate.
          headerSearchBarOptions:
            NATIVE_LIQUID_GLASS_SUPPORTED || tab.searchMode !== "resting"
              ? {
                  ref: searchRef,
                  autoFocus: tab.searchMode === "active",
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  placement: NATIVE_LIQUID_GLASS_SUPPORTED ? "integratedButton" : "stacked",
                  allowToolbarIntegration: NATIVE_LIQUID_GLASS_SUPPORTED,
                  placeholder:
                    selectedTab === "pullRequests" ? "Search pull requests" : "Search threads",
                  cancelButtonText: "✕",
                  onFocus: () =>
                    tab.searchMode === "resting"
                      ? enterSearch()
                      : workspace.dispatch({ type: "search", tab: selectedTab }),
                  onBlur: () => workspace.dispatch({ type: "expand", tab: selectedTab }),
                  onSearchButtonPress: () => searchRef.current?.blur(),
                  onChangeText: ({ nativeEvent }) =>
                    workspace.dispatch({
                      type: "query",
                      query: nativeEvent.text,
                      tab: selectedTab,
                    }),
                  onCancelButtonPress: () => {
                    workspace.recordScrollOffset(selectedTab, tab.searchEntryOffset);
                    workspace.dispatch({ type: "cancel", tab: selectedTab });
                  },
                }
              : undefined,
        }}
      />
      {/* UIKit lays trailing items out from the edge inward. */}
      <Toolbar placement="right">
        <Toolbar.Button
          accessibilityLabel="Settings"
          icon="gearshape"
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
        />
        {NATIVE_LIQUID_GLASS_SUPPORTED ? null : (
          <Toolbar.Button
            accessibilityLabel={
              selectedTab === "pullRequests" ? "Search pull requests" : "Search threads"
            }
            icon="magnifyingglass"
            onPress={focusSearch}
          />
        )}
      </Toolbar>
      <Toolbar placement="bottom">
        {sidebarTabs === "toolbar" ? (
          <Toolbar.Button
            identifier="workspace-tab-threads"
            accessibilityLabel="Threads"
            icon={selectedTab === "threads" ? "text.bubble.fill" : "text.bubble"}
            tintColor={selectedTab === "threads" ? selectedTint : undefined}
            onPress={() => selectTab("threads")}
          />
        ) : null}
        {sidebarTabs === "toolbar" ? (
          <Toolbar.Button
            identifier="workspace-tab-pull-requests"
            accessibilityLabel="Pull requests"
            icon={{ type: "image", source: PULL_REQUEST_ICON, tinted: true }}
            tintColor={selectedTab === "pullRequests" ? selectedTint : undefined}
            onPress={() => selectTab("pullRequests")}
          />
        ) : null}
        {nativeToolbarCompose ? <Toolbar.Spacer flexible /> : null}
        {nativeToolbarCompose ? (
          <Toolbar.Button
            identifier="workspace-compose"
            accessibilityLabel="New chat"
            icon="square.and.pencil"
            onPress={props.onNewTask}
            separateBackground
          />
        ) : null}
      </Toolbar>
    </>
  );
}
