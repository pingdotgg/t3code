import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
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
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { ControlPillMenu } from "../../components/ControlPill";
import { MaterialSearchField } from "../../components/MaterialSearchField";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceConnectionTitle } from "./WorkspaceConnectionTitle";
import { useWorkspaceState } from "../../state/workspace";
import { useMaterialToolbarHeight } from "../../components/useMaterialToolbarHeight";

/** One toolbar height for the compact list and expanded sidebar, including search. */
export function MaterialThreadListToolbar(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterActions: MenuAction[];
  readonly filterCustomized: boolean;
  readonly onFilterAction: NonNullable<ComponentProps<typeof ControlPillMenu>["onPressAction"]>;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironments: () => void;
  readonly sidebar?: boolean;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly onRequestVisibility?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const toolbarHeight = useMaterialToolbarHeight();
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
    if (!searching) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching]);

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
          props.sidebar
            ? "absolute inset-x-0 top-0 z-[4] bg-header px-2 pb-2"
            : "bg-header px-2 pb-2"
        }
        style={{ paddingTop: Math.max(insets.top, 12) }}
      >
        <View className="flex-row items-center gap-1" style={{ minHeight: toolbarHeight }}>
          {searching ? (
            <>
              <AndroidHeaderIconButton
                accessibilityLabel="Close search"
                icon="arrow.left"
                onPress={closeSearch}
              />
              {searchField}
            </>
          ) : (
            <>
              {/* Match the visible inset of the trailing 48dp icon button. */}
              <View className="min-w-0 flex-1 pl-4">
                <WorkspaceConnectionTitle
                  grow
                  onPress={props.onOpenEnvironments}
                  brand={<CompactBrandTitle allowFontScaling={false} />}
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
      {/* Sit 8dp above the 56dp extended New thread FAB. */}
      {state.hasConnections ? (
        <View
          className="absolute right-5 z-[5]"
          style={{
            bottom:
              (props.sidebar ? Math.max(insets.bottom, 12) + 6 : Math.max(insets.bottom, 16) + 16) +
              56 +
              8,
          }}
        >
          <AndroidAnchoredMenu actions={props.filterActions} onPressAction={props.onFilterAction}>
            {(open) => (
              <MaterialFloatingActionButton
                label="Filter and sort threads"
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
