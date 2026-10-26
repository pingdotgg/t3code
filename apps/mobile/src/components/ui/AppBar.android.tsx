import { useCallback, useRef, useState } from "react";
import { Keyboard, Pressable, TextInput, type TextInputInstance, View } from "react-native";
import { useHardwareBack } from "../../lib/backHandler";
import { useToolbarLayout } from "./useToolbarLayout";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidWorkspaceSidebarButton } from "../../features/layout/workspace-sidebar-toolbar";
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { AndroidScreenHeader } from "./AndroidScreenHeader";
import { ScreenHeaderButton } from "./ScreenHeaderButton.android";
import { SymbolView } from "./AppSymbol";
import { Menu } from "./Menu";
import { SearchField } from "./SearchField";
import { androidHeaderMenuActions, findHeaderMenuAction } from "./headerMenu.android";
import type { AppBarProps } from "./AppBar.types";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

export function AppBar(props: AppBarProps) {
  const { search } = props;
  const { paddingTop, paddingBottom } = useToolbarLayout();
  const { scale, buttonSize, iconSize, smallIconSize } = useAndroidControlSizing();
  const { themeVariables } = useAppearancePreferences();
  const inputRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = search !== undefined && (searchOpen || search.value.length > 0);
  const onSearchChange = search?.onChangeText;
  const closeSearch = useCallback(() => {
    onSearchChange?.("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchChange]);
  useHardwareBack(searching && search?.mode !== "inline", () => {
    closeSearch();
    return true;
  });
  const menuView = props.menus?.map((menu) => (
    <Menu
      key={menu.title}
      actions={androidHeaderMenuActions(menu.items)}
      isAnchoredToRight
      title={menu.status ?? menu.title}
      onPressAction={({ nativeEvent }) => {
        const action = findHeaderMenuAction(menu.items, nativeEvent.event);
        if (action && !action.disabled) action.onPress();
      }}
    >
      {search?.mode === "inline" ? (
        <Pressable
          accessibilityLabel={menu.title}
          accessibilityRole="button"
          className="items-center justify-center rounded-full bg-subtle"
          style={{ width: buttonSize, height: buttonSize }}
        >
          <SymbolView
            name={menu.icon}
            size={smallIconSize}
            tintColorClassName="accent-header-foreground"
            type="monochrome"
          />
        </Pressable>
      ) : (
        <ScreenHeaderButton accessibilityLabel={menu.title} icon={menu.icon} />
      )}
    </Menu>
  ));
  const options = (
    <NativeStackScreenOptions
      options={{
        ...props.options,
        ...(props.matchSearchSurface
          ? { contentStyle: { backgroundColor: themeVariables["--color-header"] } }
          : undefined),
        headerShown: false,
        title: props.title,
      }}
      optionsVersion={props.optionsVersion}
    />
  );
  if (search?.mode === "inline") {
    return (
      <>
        {options}
        <View
          className="border-b border-header-border bg-header px-3"
          style={{
            paddingTop,
            paddingBottom: 8.75 * scale,
            borderBottomWidth: 0,
          }}
        >
          <View className="flex-row items-center gap-2" style={{ minHeight: buttonSize }}>
            {props.onBack ? (
              <Pressable
                accessibilityLabel="Navigate up"
                accessibilityRole="button"
                hitSlop={8}
                onPress={props.onBack}
                className="items-center justify-center"
                style={{ width: buttonSize, height: buttonSize }}
              >
                <SymbolView
                  name="chevron.left"
                  size={iconSize}
                  tintColorClassName="accent-header-foreground"
                  type="monochrome"
                />
              </Pressable>
            ) : null}
            <View
              className="flex-1 flex-row items-center bg-input"
              style={{
                minHeight: Math.max(48, 38.5 * scale),
                gap: 8.75 * scale,
                borderRadius: 14 * scale,
                paddingHorizontal: 12.25 * scale,
              }}
            >
              <SymbolView
                name="magnifyingglass"
                size={Math.round(17 * scale)}
                tintColorClassName="accent-header-foreground"
                type="monochrome"
              />
              <TextInput
                accessibilityLabel={search.placeholder}
                autoCapitalize="none"
                onChangeText={search.onChangeText}
                value={search.value}
                placeholder={
                  search.compactToolbar
                    ? (search.compactPlaceholder ?? search.placeholder)
                    : search.placeholder
                }
                placeholderTextColorClassName="accent-placeholder"
                className="flex-1 text-base font-sans text-header-foreground"
                style={{ paddingVertical: 7 * scale }}
              />
            </View>
            {menuView}
          </View>
        </View>
      </>
    );
  }
  const header = (
    <AndroidScreenHeader
      title={props.title}
      subtitle={props.subtitle}
      onBack={props.onBack}
      leading={props.sidebar !== false ? <AndroidWorkspaceSidebarButton /> : undefined}
      hideBottomBorder={props.hideBottomBorder}
      compact={props.compact}
      actions={
        search
          ? [
              {
                accessibilityLabel: search.placeholder,
                icon: "magnifyingglass",
                onPress: () => setSearchOpen(true),
              },
              ...(search.refreshInToolbar && search.onRefresh
                ? [
                    {
                      accessibilityLabel: search.refreshAccessibilityLabel ?? "Refresh",
                      icon: "arrow.clockwise" as const,
                      onPress: search.onRefresh,
                    },
                  ]
                : []),
              ...(props.actions ?? []),
            ]
          : props.actions
      }
      trailing={
        menuView?.length || props.trailing ? (
          <>
            {menuView}
            {props.trailing}
          </>
        ) : undefined
      }
    />
  );
  return (
    <>
      {options}
      {search ? (
        <View>
          <View
            pointerEvents={searching ? "none" : "auto"}
            accessibilityElementsHidden={searching}
            importantForAccessibility={searching ? "no-hide-descendants" : "auto"}
            style={{ opacity: searching ? 0 : 1 }}
          >
            {header}
          </View>
          {searching ? (
            <View
              className="absolute inset-0 bg-header"
              // Match Material TopAppBar's navigation inset so the back button stays put.
              style={{ paddingTop, paddingBottom, paddingHorizontal: 4 }}
            >
              <View className="flex-1 flex-row items-center gap-1">
                <ScreenHeaderButton
                  accessibilityLabel={search.closeAccessibilityLabel ?? "Close search"}
                  icon="arrow.left"
                  onPress={closeSearch}
                />
                <SearchField
                  inputRef={inputRef}
                  accessibilityLabel={search.placeholder}
                  clearAccessibilityLabel={search.clearAccessibilityLabel ?? "Clear search"}
                  placeholder={search.placeholder}
                  value={search.value}
                  onChangeText={search.onChangeText}
                />
              </View>
            </View>
          ) : null}
        </View>
      ) : (
        header
      )}
    </>
  );
}
