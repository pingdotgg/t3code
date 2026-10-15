import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { BackHandler, Keyboard, View, type TextInputInstance } from "react-native";
import {
  AndroidHeaderIconButton,
  AndroidScreenHeader,
} from "../../components/ui/AndroidScreenHeader";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { SearchField } from "../../components/ui/SearchField";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";

/** PR search shares the thread list's native Android header placement. */
export function PullRequestToolbar(props: { readonly onRequestVisibility?: () => void }) {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs()!;
  const { dispatch, getScrollOffset, recordScrollOffset, isTabActive } = workspace;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const listFocused = homeFocused && workspace.state.selectedTab === "pullRequests";
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
  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens can keep effects alive after a detail route opens.
      const state = navigation.getState();
      if (!state || state.routes[state.index]?.name !== "Home" || !isTabActive("pullRequests"))
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [searching, closeSearch, listFocused, navigation, isTabActive]);
  return (
    <AndroidScreenHeader
      title="Pull requests"
      titleContent={
        searching ? (
          <SearchField
            inputRef={input}
            accessibilityLabel="Search pull requests"
            clearAccessibilityLabel="Clear search"
            placeholder="Search pull requests"
            value={tab.query}
            onChangeText={(query) => dispatch({ type: "query", tab: "pullRequests", query })}
          />
        ) : (
          <View className="min-w-0 flex-1 pl-3">
            <WorkspaceConnectionTitle
              grow
              brand={
                <CompactBrandTitle
                  allowFontScaling={false}
                  accessibilityLabel="T3 Code, Pull requests"
                />
              }
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsEnvironments" },
                })
              }
            />
          </View>
        )
      }
      leading={
        searching ? (
          <AndroidHeaderIconButton
            accessibilityLabel="Close search"
            icon="arrow.left"
            onPress={closeSearch}
          />
        ) : undefined
      }
      actions={
        searching
          ? []
          : [
              {
                accessibilityLabel: "Search pull requests",
                icon: "magnifyingglass",
                onPress: openSearch,
              },
              {
                accessibilityLabel: "Open settings",
                icon: "gearshape",
                onPress: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "Settings" },
                  }),
              },
            ]
      }
    />
  );
}
