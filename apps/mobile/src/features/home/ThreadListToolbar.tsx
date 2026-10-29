import { useEffect, useRef, useState } from "react";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { BackHandler, Keyboard, type TextInputInstance } from "react-native";
import type { MenuAction } from "@react-native-menu/menu";

import { SearchField } from "../../components/ui/SearchField";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceListAppBar } from "../workspace/WorkspaceListAppBar";
import { useWorkspaceConnectionState } from "../../state/workspace";

export function ThreadListToolbar(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterActions: MenuAction[];
  readonly filterCustomized: boolean;
  readonly onFilterSelect: (id: string) => void;
  readonly onOpenEnvironments: () => void;
  readonly onRequestVisibility?: () => void;
}) {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const isTabActive = workspace?.isTabActive;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const listFocused =
    homeFocused && (workspace === null || workspace.state.selectedTab === "threads");
  const connectionState = useWorkspaceConnectionState();
  const { onRequestVisibility, onSearchQueryChange } = props;
  const searchRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const openSearch = () => {
    onRequestVisibility?.();
    setSearchOpen(true);
    searchRef.current?.focus();
    return true;
  };
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = () => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to BackHandler while searching to close search on Android back
  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens can keep effects alive after a detail route opens.
      const state = navigation.getState();
      if (
        !state ||
        state.routes[state.index]?.name !== "Home" ||
        isTabActive?.("threads") === false
      )
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching, listFocused, navigation, isTabActive]);

  const searchField = (
    <SearchField
      inputRef={searchRef}
      accessibilityLabel="Search threads"
      clearAccessibilityLabel="Clear search"
      placeholder="Search"
      value={props.searchQuery}
      onChangeText={onSearchQueryChange}
    />
  );
  const filter = connectionState.hasConnections
    ? {
        accessibilityLabel: "Filter threads",
        customized: props.filterCustomized,
        actions: props.filterActions,
        onSelect: props.onFilterSelect,
      }
    : undefined;

  return (
    <WorkspaceListAppBar
      searching={searching}
      searchField={searchField}
      onCloseSearch={closeSearch}
      onOpenSearch={openSearch}
      searchAccessibilityLabel="Search threads"
      titleAccessibilityLabel="T3 Code, Threads"
      onOpenEnvironments={props.onOpenEnvironments}
      filter={filter}
    />
  );
}
