import { useFocusEffect } from "@react-navigation/native";
import { use, useCallback, useEffect, useRef } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import type { SearchBarCommands } from "react-native-screens";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { NativeWorkspaceTabActivityContext } from "../../../native/v5-workspace-context";
import type { HomeListFilterMenu } from "../../home/home-list-filter-menu";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import { useAdaptiveWorkspaceLayout } from "../AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../native-glass-header-items";
import { useCreateNativeMailSearchToolbarItem } from "../native-mail-search-toolbar";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

const SWITCHER_HEIGHT = 48;
// The selected pill sits this far inside the glass, with concentric corners. The
// toolbar already pads custom views by about this much at the sides, so the group
// only pads top and bottom.
const SWITCHER_PADDING = 4;
const SWITCHER_ITEM_WIDTH = 64;
// The toolbar keeps this much room for its two 48pt buttons, gaps and margins.
const TOOLBAR_RESERVED = 20 * 2 + 48 * 2 + 12 * 2;

const SWITCHER_ITEMS = [
  { key: "threads", accessibilityLabel: "Threads", icon: "text.bubble" },
  { key: "tasks", accessibilityLabel: "Tasks", icon: "checklist" },
  { key: "pullRequests", accessibilityLabel: "Pull requests", icon: PullRequestGlyph.pullRequest },
  { key: "search", accessibilityLabel: "Search", icon: "magnifyingglass" },
] as const;

function switcherWidth(windowWidth: number) {
  return Math.min(SWITCHER_ITEM_WIDTH * SWITCHER_ITEMS.length, windowWidth - TOOLBAR_RESERVED);
}

/** Threads, Tasks, Pulls and Search share one glass group of icons in the toolbar. Usage is in Settings. */
function WorkspacePhoneSwitcher(props: {
  readonly width: number;
  readonly selectedTab: WorkspaceTab;
  readonly onSelect: (tab: WorkspaceTab) => void;
  readonly onSearch: () => void;
}) {
  // Usage has nothing to search, so it drops the Search item.
  const items = SWITCHER_ITEMS.filter(
    (item) => item.key !== "search" || props.selectedTab !== "usage",
  );
  const itemWidth = props.width / items.length;
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        width: props.width,
        height: SWITCHER_HEIGHT,
        paddingVertical: SWITCHER_PADDING,
      }}
    >
      {items.map((item) => {
        const selected = item.key === props.selectedTab;
        return (
          <Pressable
            key={item.key}
            accessibilityRole={item.key === "search" ? "button" : "tab"}
            accessibilityLabel={item.accessibilityLabel}
            accessibilityState={item.key === "search" ? undefined : { selected }}
            onPress={() => {
              if (item.key === "search") props.onSearch();
              else if (!selected) props.onSelect(item.key);
            }}
            className={selected ? "bg-foreground/12" : undefined}
            style={{
              width: itemWidth,
              borderRadius: (SWITCHER_HEIGHT - SWITCHER_PADDING * 2) / 2,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <SymbolView
              name={item.icon}
              size={22}
              tintColorClassName={selected ? "accent-foreground" : "accent-foreground-muted"}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Conn's iPhone bottom bar: settings, the Threads / Pulls / Search group, and New chat.
 * Search swaps the group for the toolbar search field, with the filter menu inside it,
 * and searches the selected tab. Cancelling, or leaving the field empty, brings the group back.
 */
export function WorkspacePhoneBar(props: {
  readonly filterMenu?: HomeListFilterMenu;
  readonly filterActive?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const createSearchItem = useCreateNativeMailSearchToolbarItem();
  const { width: windowWidth } = useWindowDimensions();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const searchRef = useRef<SearchBarCommands>(null);
  const { isTabActive } = workspace;
  const selectedTab = workspace.state.selectedTab;
  const tab = workspace.state.tabs[selectedTab];
  const searching = tab.searchMode !== "resting";

  const startSearch = useCallback(() => {
    if (selectedTab === "usage" || !workspace.isTabActive(selectedTab)) return false;
    workspace.dispatch({
      type: "scroll",
      tab: selectedTab,
      offset: workspace.getScrollOffset(selectedTab),
    });
    workspace.dispatch({ type: "search", tab: selectedTab });
    searchRef.current?.focus();
    return true;
  }, [workspace, selectedTab]);
  useHardwareKeyboardCommand("focusSearch", startSearch);
  const endSearch = () => {
    workspace.recordScrollOffset(selectedTab, tab.searchEntryOffset);
    workspace.dispatch({ type: "cancel", tab: selectedTab });
  };

  // The native field is recreated when the screen returns; give it back its query.
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules a frame to restore the native search bar's text when its tab becomes active
  useEffect(() => {
    if (!tabActive) return;
    const frame = requestAnimationFrame(restoreSearch);
    return () => cancelAnimationFrame(frame);
  }, [restoreSearch, tabActive]);

  const { startNewTask: openNewTask } = useAdaptiveWorkspaceLayout();
  const selectTab = useSelectWorkspaceTab();
  const settingsItem = withNativeGlassHeaderItem({
    accessibilityLabel: "Open settings",
    axisBehavior: "horizontalOnly",
    icon: { name: "ellipsis", type: "sfSymbol" } as const,
    identifier: "workspace-settings",
    label: "",
    onPress: () => selectTab("settings"),
    type: "button",
  });

  return (
    <NativeStackScreenOptions
      optionsVersion={[
        selectedTab,
        tab.searchMode,
        windowWidth,
        props.filterMenu?.items,
        props.filterActive,
      ]}
      options={{
        unstable_headerRightItems: () => [],
        headerSearchBarOptions: searching
          ? {
              ref: searchRef,
              autoFocus: tab.searchMode === "active",
              autoCapitalize: "none",
              onFocus: () => workspace.dispatch({ type: "search", tab: selectedTab }),
              onBlur: () => {
                if (tab.query.trim() === "") endSearch();
                else workspace.dispatch({ type: "expand", tab: selectedTab });
              },
              onSearchButtonPress: () => searchRef.current?.blur(),
              onCancelButtonPress: endSearch,
            }
          : undefined,
        // oxlint-disable-next-line react/no-unstable-nested-components -- native header adapter asks for an items factory, not a React component
        unstable_headerToolbarItems: () =>
          searching
            ? [
                settingsItem,
                createSearchItem({
                  composeButtonId: "workspace-new-task",
                  composeSystemImageName: "plus",
                  filterInsideSearch: true,
                  filterMenu: props.filterMenu,
                  filterButtonId: "workspace-filter",
                  filterSystemImageName: props.filterActive
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onComposePress: openNewTask,
                  onSearchTextChange: (query) =>
                    workspace.dispatch({
                      type: "query",
                      query,
                      tab: selectedTab,
                    }),
                  placeholder:
                    selectedTab === "pullRequests"
                      ? "Search pull requests"
                      : selectedTab === "tasks"
                        ? "Search tasks"
                        : "Search threads",
                  searchTextChangeId: "workspace-search-text",
                }),
              ]
            : [
                settingsItem,
                { type: "spacing", spacing: 8, flexible: true },
                {
                  type: "custom",
                  element: (
                    <WorkspacePhoneSwitcher
                      width={switcherWidth(windowWidth)}
                      selectedTab={selectedTab}
                      onSelect={selectTab}
                      onSearch={startSearch}
                    />
                  ),
                },
                { type: "spacing", spacing: 8, flexible: true },
                withNativeGlassHeaderItem({
                  accessibilityLabel: "New chat",
                  axisBehavior: "horizontalOnly",
                  icon: { name: "plus", type: "sfSymbol" } as const,
                  identifier: "workspace-new-task",
                  label: "",
                  onPress: openNewTask,
                  type: "button",
                }),
              ],
      }}
    />
  );
}
