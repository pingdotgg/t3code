import { Toolbar } from "../../components/ui/Toolbar";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { use, useCallback, useEffect, useRef, type ReactNode } from "react";
import { Platform, Pressable, type TextInputInstance } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isDuoDevice } from "../../lib/device-type";
import { useDeviceType, useDuoBottomBarInset } from "../../native/native-layout-metrics";
import type { SearchBarCommands } from "react-native-screens";

import { SymbolView } from "../../components/ui/AppSymbol";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceSearchField } from "./WorkspaceSearchField";
import { WORKSPACE_TOOLBAR } from "./workspace-tabs-state";
import { useSidebarWorkspaceTabs } from "./useSystemWorkspaceTabBar";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";

// Tabler's git-pull-request geometry, shared with the UIKit tab bar.
const PULL_REQUEST_ICON = require("../../../assets/icons/pull-request.png");

/**
 * Rises once the keyboard reaches its content. UIKit also reports keyboards without height, with a
 * hardware keyboard and around a fold, and those must not move it.
 */
function AboveKeyboard(props: { readonly bottom: number; readonly children: ReactNode }) {
  const keyboard = useReanimatedKeyboardAnimation();
  const { bottom } = props;
  const lift = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.min(0, keyboard.height.value + bottom - 8) }],
  }));
  return (
    <Animated.View
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0 flex-row items-center"
      style={[
        {
          gap: WORKSPACE_TOOLBAR.gap,
          paddingHorizontal: WORKSPACE_TOOLBAR.edge,
          paddingBottom: bottom,
        },
        lift,
      ]}
    >
      {props.children}
    </Animated.View>
  );
}

export function WorkspaceToolbar(props: {
  readonly onNewTask: () => void;
  readonly sidebar?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  const deviceType = useDeviceType();
  const sidebarTabs = useSidebarWorkspaceTabs();
  const selectTab = useSelectWorkspaceTab();
  const selectedTint = useMobileNavigationTheme().colors.primary;
  // On the Duo, compose belongs to the threads tab, in the detail column's bar when unfolded.
  const nativeToolbarCompose =
    Platform.OS === "ios" &&
    (isDuoDevice(deviceType)
      ? deviceType === "duo-folded" && workspace.state.selectedTab === "threads"
      : deviceType === "pad");
  // The Duo searches from a field at the bottom of the list in every pose. UIKit has no such
  // placement once the vertical bar holds the toolbar, and re-placing its search controller on
  // each fold replaces the search field.
  const listSearch = isDuoDevice(deviceType);
  const insets = useSafeAreaInsets();
  const bottomBarInset = useDuoBottomBarInset();
  const { isTabActive } = workspace;
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const { panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const searchRef = useRef<SearchBarCommands>(null);
  const fieldRef = useRef<TextInputInstance>(null);
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
    if (listSearch) {
      fieldRef.current?.focus();
      return true;
    }
    if (!NATIVE_LIQUID_GLASS_SUPPORTED) enterSearch();
    searchRef.current?.focus();
    return true;
  }, [workspace, selectedTab, listSearch, enterSearch]);
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
            !listSearch && (NATIVE_LIQUID_GLASS_SUPPORTED || tab.searchMode !== "resting")
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
      {listSearch ? (
        <AboveKeyboard bottom={bottomBarInset ?? Math.max(insets.bottom, 12)}>
          <WorkspaceSearchField
            ref={fieldRef}
            tab={selectedTab}
            query={tab.query}
            onChangeQuery={(query) =>
              workspace.dispatch({ type: "query", query, tab: selectedTab })
            }
            onFocus={searchFocused}
            onBlur={() => workspace.dispatch({ type: "expand", tab: selectedTab })}
            onClear={() => {
              workspace.dispatch({ type: "query", query: "", tab: selectedTab });
              fieldRef.current?.focus();
            }}
          />
          {tab.searchMode === "resting" ? null : (
            <GlassSurface
              style={{
                width: WORKSPACE_TOOLBAR.height,
                height: WORKSPACE_TOOLBAR.height,
                borderRadius: WORKSPACE_TOOLBAR.height / 2,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel search"
                onPress={() => {
                  cancelSearch();
                  fieldRef.current?.blur();
                }}
                className="flex-1 items-center justify-center"
              >
                <SymbolView name="xmark" size={20} tintColorClassName="accent-icon" />
              </Pressable>
            </GlassSurface>
          )}
        </AboveKeyboard>
      ) : null}
    </>
  );
}
