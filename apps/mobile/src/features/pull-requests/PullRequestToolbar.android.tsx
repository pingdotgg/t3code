import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { BackHandler, Keyboard, View, type TextInputInstance } from "react-native";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { SearchField } from "../../components/ui/SearchField";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceListToolbarRow } from "../workspace/WorkspaceListToolbarRow";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import type { PullRequestFilterMenu } from "./PullRequestListFilters";
import { openSettings } from "../settings/settings-navigation";

/** PR search shares the thread list's Android header row. */
export function PullRequestToolbar(props: {
  readonly filters: PullRequestFilterMenu | null;
  readonly onRequestVisibility?: () => void;
}) {
  const navigation = useNavigation();
  const { filters } = props;
  const workspace = useWorkspaceTabs()!;
  const { dispatch, getScrollOffset, recordScrollOffset, isTabActive } = workspace;
  const { onRequestVisibility } = props;
  const tab = workspace.state.tabs.pullRequests;
  const input = useRef<TextInputInstance>(null);
  const searching = tab.searchMode !== "resting";
  const openSearch = useCallback(() => {
    onRequestVisibility?.();
    dispatch({
      type: "scroll",
      tab: "pullRequests",
      offset: getScrollOffset("pullRequests"),
    });
    dispatch({ type: "search", tab: "pullRequests" });
    input.current?.focus();
    return true;
  }, [dispatch, getScrollOffset, onRequestVisibility]);
  useHardwareKeyboardCommand("focusSearch", openSearch);
  const closeSearch = useCallback(() => {
    Keyboard.dismiss();
    recordScrollOffset("pullRequests", tab.searchEntryOffset);
    dispatch({ type: "cancel", tab: "pullRequests" });
  }, [dispatch, recordScrollOffset, tab.searchEntryOffset]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to BackHandler while searching to close the PR search on Android back
  useEffect(() => {
    if (!searching) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens stay mounted under a detail route or another tab,
      // so back only applies while the PR list is in front.
      const state = navigation.getState();
      if (!state || state.routes[state.index]?.name !== "Home" || !isTabActive("pullRequests"))
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [searching, closeSearch, navigation, isTabActive]);
  const { paddingTop, paddingBottom } = useToolbarLayout();
  return (
    <View className="bg-header px-2" style={{ paddingTop, paddingBottom }}>
      <WorkspaceListToolbarRow
        searching={searching}
        searchField={
          <SearchField
            inputRef={input}
            accessibilityLabel="Search pull requests"
            clearAccessibilityLabel="Clear search"
            placeholder="Search pull requests"
            value={tab.query}
            onChangeText={(query) => dispatch({ type: "query", tab: "pullRequests", query })}
          />
        }
        onCloseSearch={closeSearch}
        onOpenSearch={openSearch}
        searchAccessibilityLabel="Search pull requests"
        titleAccessibilityLabel="T3 Code, Pull requests"
        onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
        filter={
          filters ? (
            <AndroidAnchoredMenu
              actions={filters.actions}
              onPressAction={({ nativeEvent }) => filters.onSelect(nativeEvent.event)}
            >
              {(open) => (
                <AndroidHeaderIconButton
                  accessibilityLabel="Filter pull requests"
                  icon={
                    filters.customized
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  onPress={open}
                />
              )}
            </AndroidAnchoredMenu>
          ) : null
        }
      />
    </View>
  );
}
