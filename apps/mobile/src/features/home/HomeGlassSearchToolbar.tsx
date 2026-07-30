import type { MenuAction } from "@react-native-menu/menu";
import { GlassContainer, GlassView } from "expo-glass-effect";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, TextInput, useColorScheme, type ViewStyle } from "react-native";
import { View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import type { HomeListFilterMenu } from "./home-list-filter-menu";

/* Metrics mirror the native mail-search toolbar this replaces (patched
   react-native-screens): 48pt capsule bar, 48pt round side buttons, 8pt gaps,
   560pt max content width inside 18pt insets, resting 4pt above the safe
   area, and a Title3-sized (20pt) search field. */
const TOOLBAR_HEIGHT = 48;
const TOOLBAR_RADIUS = TOOLBAR_HEIGHT / 2;
const BUTTON_SIZE = TOOLBAR_HEIGHT;
const ELEMENT_GAP = 8;
const CONTENT_MAX_WIDTH = 560;
const HORIZONTAL_INSET = 18;
const BOTTOM_SPACING = 4;

/* Below the resting 8pt gap so the elements read as separate pills at rest,
   while UIGlassContainerEffect can still merge and morph them the moment
   they animate closer together. */
const GLASS_MERGE_SPACING = 4;

const CIRCLE_BUTTON_STYLE: ViewStyle = {
  alignItems: "center",
  borderRadius: TOOLBAR_RADIUS,
  height: BUTTON_SIZE,
  justifyContent: "center",
  overflow: "hidden",
  width: BUTTON_SIZE,
};

const FILL_CENTER_STYLE: ViewStyle = {
  alignItems: "center",
  height: "100%",
  justifyContent: "center",
  width: "100%",
};

/** Flattens the shared filter-menu model into MenuView actions plus an
    id → onPress lookup, so the same menu drives this JS toolbar and the
    native header elsewhere. */
function useFilterMenuActions(menu: HomeListFilterMenu) {
  return useMemo(() => {
    const handlers = new Map<string, () => void>();
    const actions: MenuAction[] = menu.items.map((item, itemIndex) => {
      if (item.type === "submenu") {
        return {
          id: `submenu:${itemIndex}`,
          title: item.title,
          subactions: item.items.map((action, actionIndex) => {
            const id = `action:${itemIndex}:${actionIndex}`;
            handlers.set(id, action.onPress);
            return {
              id,
              title: action.title,
              subtitle: action.subtitle,
              state: action.state === "on" ? ("on" as const) : undefined,
            };
          }),
        };
      }
      const id = `action:${itemIndex}`;
      handlers.set(id, item.onPress);
      return {
        id,
        title: item.title,
        subtitle: item.subtitle,
        state: item.state === "on" ? ("on" as const) : undefined,
      };
    });
    return { actions, handlers };
  }, [menu]);
}

/**
 * JS bottom search toolbar for liquid-glass iOS: filter button, search
 * field, and compose button as sibling GlassViews inside one GlassContainer
 * (UIGlassContainerEffect), so the three glass elements share one container
 * and can merge / morph together — the previous native toolbar drew them as
 * three unrelated glass surfaces. Each glass view keeps the same shape,
 * size, and regular glass style it had natively.
 */
export function HomeGlassSearchToolbar(props: {
  readonly searchQuery: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly filterIcon: AppSymbolName;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onStartNewTask: () => void;
}) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const foregroundColor = useThemeColor("--color-foreground");
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const searchInputRef = useRef<TextInput>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const { actions: filterActions, handlers: filterHandlers } = useFilterMenuActions(
    props.filterMenu,
  );

  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
    return searchInputRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);

  return (
    <KeyboardStickyView
      pointerEvents="box-none"
      style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
      offset={{ closed: 0, opened: 0 }}
    >
      <View
        pointerEvents="box-none"
        style={{
          alignSelf: "center",
          maxWidth: CONTENT_MAX_WIDTH + HORIZONTAL_INSET * 2,
          paddingBottom: searchFocused ? ELEMENT_GAP : insets.bottom + BOTTOM_SPACING,
          paddingHorizontal: HORIZONTAL_INSET,
          width: "100%",
        }}
      >
        <GlassContainer
          pointerEvents="box-none"
          spacing={GLASS_MERGE_SPACING}
          style={{ alignItems: "center", flexDirection: "row", gap: ELEMENT_GAP }}
        >
          <GlassView colorScheme={colorScheme} isInteractive style={CIRCLE_BUTTON_STYLE}>
            {/* JS anchored menu (the same one ControlPillMenu renders on
                Android) instead of a native UIMenu: presenting a UIMenu from
                a view in this overlay leaves UIKit's responder chain in a
                broken state on iOS 26 — the menu opens invisibly behind a
                phantom system keyboard. The portal-rendered JS menu skips
                UIKit menu presentation entirely. */}
            <AndroidAnchoredMenu
              actions={filterActions}
              style={FILL_CENTER_STYLE}
              onPressAction={({ nativeEvent }) => {
                filterHandlers.get(nativeEvent.event)?.();
              }}
            >
              {(open) => (
                <Pressable
                  accessibilityLabel="Filter and sort threads"
                  accessibilityRole="button"
                  onPress={open}
                  style={FILL_CENTER_STYLE}
                >
                  <SymbolView name={props.filterIcon} size={17} tintColor={iconColor} />
                </Pressable>
              )}
            </AndroidAnchoredMenu>
          </GlassView>

          <GlassView
            colorScheme={colorScheme}
            isInteractive
            style={{
              alignItems: "center",
              borderRadius: TOOLBAR_RADIUS,
              flex: 1,
              flexDirection: "row",
              gap: ELEMENT_GAP,
              height: TOOLBAR_HEIGHT,
              overflow: "hidden",
              paddingHorizontal: 14,
            }}
          >
            <SymbolView name="magnifyingglass" size={17} tintColor={mutedColor} />
            <TextInput
              ref={searchInputRef}
              accessibilityLabel="Search threads"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              onBlur={() => setSearchFocused(false)}
              onChangeText={props.onSearchQueryChange}
              onFocus={() => setSearchFocused(true)}
              placeholder="Search"
              placeholderTextColor={mutedColor}
              returnKeyType="search"
              style={{ color: foregroundColor, flex: 1, fontSize: 20, paddingVertical: 0 }}
              value={props.searchQuery}
            />
          </GlassView>

          <GlassView colorScheme={colorScheme} isInteractive style={CIRCLE_BUTTON_STYLE}>
            <Pressable
              accessibilityLabel="New task"
              accessibilityRole="button"
              onPress={props.onStartNewTask}
              style={FILL_CENTER_STYLE}
            >
              <SymbolView name="square.and.pencil" size={17} tintColor={iconColor} />
            </Pressable>
          </GlassView>
        </GlassContainer>
      </View>
    </KeyboardStickyView>
  );
}
