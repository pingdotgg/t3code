import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";
import { BackHandler, Keyboard } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { openSettings } from "../settings/settings-navigation";
import { WorkspaceBrandTitle } from "../layout/workspace/WorkspaceBrandTitle";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";

/** Linear search shares the thread list's Android header; it is the workspace jump search. */
export function LinearToolbar() {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs()!;
  const { dispatch, getScrollOffset, recordScrollOffset, isTabActive } = workspace;
  const tab = workspace.state.tabs.linear;
  const searching = tab.searchMode !== "resting";
  const openSearch = () => {
    dispatch({ type: "scroll", tab: "linear", offset: getScrollOffset("linear") });
    dispatch({ type: "search", tab: "linear" });
    return true;
  };
  useHardwareKeyboardCommand("focusSearch", openSearch);
  const closeSearch = () => {
    Keyboard.dismiss();
    recordScrollOffset("linear", tab.searchEntryOffset);
    dispatch({ type: "cancel", tab: "linear" });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to BackHandler while searching to close the Linear search on Android back
  useEffect(() => {
    if (!searching) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens stay mounted under a detail route or another tab,
      // so back only applies while the Linear tab is in front.
      const state = navigation.getState();
      if (!state || state.routes[state.index]?.name !== "Home" || !isTabActive("linear"))
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [searching, closeSearch, navigation, isTabActive]);
  return (
    <AppBar
      title="T3 Code"
      titleContent={
        <WorkspaceBrandTitle
          accessibilityLabel="T3 Code, Linear"
          onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
        />
      }
      search={{
        value: tab.query,
        onChangeText: (query) => dispatch({ type: "query", tab: "linear", query }),
        placeholder: "Search issues",
        active: searching,
        onOpen: openSearch,
        onClose: closeSearch,
      }}
    />
  );
}
