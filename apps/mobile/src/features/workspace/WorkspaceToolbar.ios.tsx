import { useActiveNewTask } from "../../state/active-new-task";
import { Toolbar } from "../../components/ui/Toolbar";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { use, useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { isDuoDevice } from "../../lib/device-type";
import { useDeviceType } from "../../native/native-layout-metrics";
import type { SearchBarCommands } from "react-native-screens";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceTabActivityContext,
} from "../../native/v5-workspace-context";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useCompactWorkspaceTabs, useSidebarWorkspaceTabs } from "./useSystemWorkspaceTabBar";
import { WorkspaceTabToolbarButtons } from "./WorkspaceSectionToolbar";

const SEARCH_LABELS = {
  threads: "Search threads",
  pullRequests: "Search pull requests",
  settings: "Search settings",
} as const;

export function WorkspaceToolbar(props: {
  readonly onNewTask: () => void;
  readonly sidebar?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const activeNewTask = useActiveNewTask();
  const deviceType = useDeviceType();
  const sidebarTabs = useSidebarWorkspaceTabs();
  const compactTabs = useCompactWorkspaceTabs();
  const duoSearch = NATIVE_LIQUID_GLASS_SUPPORTED && isDuoDevice(deviceType);
  const bottomSearch = duoSearch && sidebarTabs !== "picker";
  // On the Duo, compose belongs to the threads tab, in the detail column's bar when unfolded.
  const nativeToolbarCompose =
    Platform.OS === "ios" &&
    deviceType === "duo-folded" &&
    !workspace.settingsOpen &&
    workspace.state.selectedTab === "threads" &&
    activeNewTask === null;
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const focused = useIsFocused();
  const { panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const searchRef = useRef<SearchBarCommands>(null);
  // The Settings list takes the selected tab's place, so search follows it.
  const selectedTab = workspace.settingsOpen ? "settings" : workspace.state.selectedTab;
  const tab = workspace.state.tabs[selectedTab];
  const searchLabel = SEARCH_LABELS[selectedTab === "usage" ? "threads" : selectedTab];
  const { isTabActive: isListTabActive } = workspace;
  const isTabActive = useCallback(
    // A retained tab slot stays mounted while another is shown.
    (tab: typeof selectedTab) => (tab === "settings" ? tabActive : isListTabActive(tab)),
    [tabActive, isListTabActive],
  );
  const foldedSearch = deviceType === "duo-folded";
  const primaryColumn = use(NativePrimaryColumnContext);
  // UIKit hosts integrated search outside the sidebar's sliding content.
  // Mount it after native appearance so it cannot precede the pane's reveal.
  const searchVisible = foldedSearch
    ? tab.searchMode !== "resting"
    : deviceType !== "duo-unfolded" || primaryColumn?.presented !== false;
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
    if (!isTabActive(selectedTab)) return false;
    if (duoSearch || !NATIVE_LIQUID_GLASS_SUPPORTED) enterSearch();
    searchRef.current?.focus();
    return true;
  }, [isTabActive, selectedTab, enterSearch, duoSearch]);
  const cancelSearch = useCallback(() => {
    workspace.recordScrollOffset(selectedTab, tab.searchEntryOffset);
    workspace.dispatch({ type: "cancel", tab: selectedTab });
  }, [workspace, selectedTab, tab.searchEntryOffset]);
  const searchFocused = useCallback(
    () =>
      tab.searchMode === "resting"
        ? enterSearch()
        : workspace.dispatch({ type: "search", tab: selectedTab }),
    [tab.searchMode, enterSearch, workspace, selectedTab],
  );
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  // The sidebar remains visible while its detail owns navigation focus.
  const searchHostVisible = focused || primaryColumn?.presented === true;
  const restoreSearch = useCallback(() => {
    if (
      searchHostVisible &&
      searchVisible &&
      isTabActive(selectedTab) &&
      tab.searchMode !== "resting"
    ) {
      searchRef.current?.setText(tab.query);
      // Integrated search collapses to its button when its screen reappears,
      // which would hide the query that still filters the list.
      if (NATIVE_LIQUID_GLASS_SUPPORTED) {
        searchRef.current?.setActive(true);
        if (tab.searchMode === "active") searchRef.current?.focus();
      }
    }
  }, [searchHostVisible, isTabActive, selectedTab, tab.searchMode, tab.query, searchVisible]);
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
  }, [restoreSearch, tabActive, bottomSearch]);
  const composeButton = nativeToolbarCompose ? (
    <Toolbar.Button
      identifier="workspace-compose"
      accessibilityLabel="New chat"
      icon="square.and.pencil"
      onPress={props.onNewTask}
      separateBackground
    />
  ) : null;
  const searchButton = foldedSearch ? (
    <Toolbar.Button
      identifier="workspace-search"
      accessibilityLabel={searchVisible ? "Close search" : searchLabel}
      icon={searchVisible ? "xmark" : "magnifyingglass"}
      onPress={searchVisible ? () => searchRef.current?.cancelSearch() : focusSearch}
      separateBackground
    />
  ) : null;
  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[selectedTab, tab.searchMode]}
        listeners={{ transitionEnd: restoreSearch }}
        options={{
          // Without Liquid Glass, Settings keeps its search field out instead of a search button,
          // which would take the header's trailing items from the scope filter.
          headerSearchBarOptions:
            (NATIVE_LIQUID_GLASS_SUPPORTED ||
              tab.searchMode !== "resting" ||
              workspace.settingsOpen) &&
            searchVisible
              ? {
                  ref: searchRef,
                  autoFocus: tab.searchMode === "active",
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  placement: NATIVE_LIQUID_GLASS_SUPPORTED
                    ? bottomSearch
                      ? "integrated"
                      : "integratedButton"
                    : "stacked",
                  allowToolbarIntegration:
                    NATIVE_LIQUID_GLASS_SUPPORTED &&
                    deviceType !== "phone" &&
                    sidebarTabs !== "picker",
                  placeholder: searchLabel,
                  cancelButtonHidden: foldedSearch,
                  onFocus: searchFocused,
                  onBlur: () => workspace.dispatch({ type: "expand", tab: selectedTab }),
                  onSearchButtonPress: () => searchRef.current?.blur(),
                  onChangeText: ({ nativeEvent }) =>
                    workspace.dispatch({
                      type: "query",
                      query: nativeEvent.text,
                      tab: selectedTab,
                    }),
                  onCancelButtonPress: cancelSearch,
                }
              : undefined,
        }}
      />
      {/* UIKit lays trailing items out from the edge inward. A trailing toolbar replaces the
          header's own items, so an empty one would hide the Settings scope filter. */}
      {workspace.settingsOpen && !foldedSearch ? null : (
        <Toolbar placement="right">
          {searchButton}
          {nativeToolbarCompose && foldedSearch ? <Toolbar.Spacer width={8} /> : null}
          {composeButton}
          {selectedTab !== "threads" ||
          isDuoDevice(deviceType) ||
          deviceType === "pad" ||
          sidebarTabs === "picker" ||
          compactTabs ? null : (
            <Toolbar.Button
              accessibilityLabel="New chat"
              icon="square.and.pencil"
              onPress={props.onNewTask}
            />
          )}
          {NATIVE_LIQUID_GLASS_SUPPORTED ? null : (
            <Toolbar.Button
              accessibilityLabel={searchLabel}
              icon="magnifyingglass"
              onPress={focusSearch}
            />
          )}
        </Toolbar>
      )}
      <Toolbar placement="bottom">
        {sidebarTabs === "toolbar" ? <WorkspaceTabToolbarButtons /> : null}
        {bottomSearch && searchVisible ? <Toolbar.SearchBarSlot /> : null}
      </Toolbar>
    </>
  );
}
