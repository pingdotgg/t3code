import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  BackHandler,
  Keyboard,
  type TextInputInstance,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MenuAction } from "@react-native-menu/menu";

import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { ControlPillMenu } from "../../components/ControlPill";
import { MaterialSearchField } from "../../components/MaterialSearchField";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceConnectionTitle } from "./WorkspaceConnectionTitle";
import { useWorkspaceState } from "../../state/workspace";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { useMaterialToolbarLayout } from "../../components/useMaterialToolbarLayout";
import { AndroidWorkspaceTabSwitch } from "../workspace/AndroidWorkspaceTabSwitch";

/**
 * One toolbar height for the compact list and expanded sidebar, including search.
 * Both lead with the Chats/PRs switch. The sidebar variant also keeps Filter and
 * New thread in the header, so nothing floats over the list.
 */
export function MaterialThreadListToolbar(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterActions: MenuAction[];
  readonly filterCustomized: boolean;
  readonly onFilterAction: NonNullable<ComponentProps<typeof ControlPillMenu>["onPressAction"]>;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironments: () => void;
  readonly sidebar?: boolean;
  /** Sidebar only: the header's New thread action. */
  readonly onStartNewTask?: () => void;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly onRequestVisibility?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const isTabActive = workspace?.isTabActive;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const listFocused =
    homeFocused && (workspace === null || workspace.state.selectedTab === "threads");
  const { fabSize } = useAndroidControlSizing();
  const { height: toolbarHeight, ...headerPadding } = useMaterialToolbarLayout();
  const { state } = useWorkspaceState();
  const { onRequestVisibility, onSearchQueryChange } = props;
  const searchRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const openSearch = useCallback(() => {
    onRequestVisibility?.();
    setSearchOpen(true);
    searchRef.current?.focus();
    return true;
  }, [onRequestVisibility]);
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = useCallback(() => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchQueryChange]);

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

  const filterIcon = props.filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const searchField = (
    <MaterialSearchField
      inputRef={searchRef}
      accessibilityLabel="Search threads"
      clearAccessibilityLabel="Clear search"
      placeholder="Search"
      value={props.searchQuery}
      onChangeText={onSearchQueryChange}
    />
  );

  return (
    <>
      <View
        onLayout={props.onLayout}
        className={
          props.sidebar ? "absolute inset-x-0 top-0 z-[4] bg-header px-2" : "bg-header px-2"
        }
        style={headerPadding}
      >
        <View
          className={
            props.sidebar
              ? "flex-row flex-wrap content-center items-center"
              : "flex-row items-center gap-1"
          }
          style={{ minHeight: toolbarHeight }}
        >
          {searching ? (
            <>
              <AndroidHeaderIconButton
                accessibilityLabel="Close search"
                icon="arrow.left"
                onPress={closeSearch}
              />
              {searchField}
            </>
          ) : props.sidebar ? (
            <>
              <View className="flex-row items-center">
                <AndroidWorkspaceTabSwitch />
                <WorkspaceConnectionTitle
                  iconOnly
                  brand={null}
                  onPress={props.onOpenEnvironments}
                />
              </View>
              {/* Wraps below the switch when large text leaves no room on one row. */}
              <View className="ml-auto flex-row items-center">
                <AndroidHeaderIconButton
                  accessibilityLabel="Search threads"
                  icon="magnifyingglass"
                  onPress={openSearch}
                />
                {state.hasConnections ? (
                  <AndroidAnchoredMenu
                    actions={props.filterActions}
                    onPressAction={props.onFilterAction}
                  >
                    {(open) => (
                      <AndroidHeaderIconButton
                        accessibilityLabel="Filter threads"
                        icon={filterIcon}
                        onPress={open}
                      />
                    )}
                  </AndroidAnchoredMenu>
                ) : null}
                <AndroidHeaderIconButton
                  accessibilityLabel="Open settings"
                  icon="gearshape"
                  onPress={props.onOpenSettings}
                />
                {state.hasConnections && props.onStartNewTask ? (
                  <MaterialIconButton
                    accessibilityLabel="New thread"
                    icon="square.and.pencil"
                    variant="primary"
                    onPress={props.onStartNewTask}
                  />
                ) : null}
              </View>
            </>
          ) : (
            <>
              <View className="min-w-0 flex-1 flex-row items-center">
                <AndroidWorkspaceTabSwitch />
                <WorkspaceConnectionTitle
                  iconOnly
                  brand={null}
                  onPress={props.onOpenEnvironments}
                />
              </View>
              <AndroidHeaderIconButton
                accessibilityLabel="Search threads"
                icon="magnifyingglass"
                onPress={openSearch}
              />
              <AndroidHeaderIconButton
                accessibilityLabel="Open settings"
                icon="gearshape"
                onPress={props.onOpenSettings}
              />
            </>
          )}
        </View>
      </View>
      {/* Keep the filter above the New thread FAB at every text size. */}
      {state.hasConnections && !props.sidebar ? (
        <View
          className="absolute right-5 z-[5]"
          style={{ bottom: Math.max(insets.bottom, 16) + 16 + fabSize + 8 }}
        >
          <AndroidAnchoredMenu actions={props.filterActions} onPressAction={props.onFilterAction}>
            {(open) => (
              <MaterialFloatingActionButton
                label="Filter threads"
                icon={filterIcon}
                onPress={open}
              />
            )}
          </AndroidAnchoredMenu>
        </View>
      ) : null}
    </>
  );
}
