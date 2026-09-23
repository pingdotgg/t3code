import { useCallback, useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Keyboard,
  Pressable,
  TextInput,
  type TextInputInstance,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../native/StackHeader";
import { AndroidWorkspaceSidebarButton } from "../features/layout/workspace-sidebar-toolbar";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { AndroidScreenHeader } from "./AndroidScreenHeader";
import { ScreenHeaderButton } from "./ScreenHeaderButton.android";
import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";
import { MaterialSearchField } from "./MaterialSearchField";
import { androidHeaderMenuActions, findHeaderMenuAction } from "./headerMenu.android";
import type { ScreenHeaderProps } from "./ScreenHeader.types";

export function ScreenHeader(props: ScreenHeaderProps) {
  const { search } = props;
  const insets = useSafeAreaInsets();
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
  useEffect(() => {
    if (!searching || search?.mode === "inline") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching, search?.mode]);
  const menuView = props.menus?.map((menu) => (
    <ControlPillMenu
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
          className="size-11 items-center justify-center rounded-full bg-subtle"
        >
          <SymbolView
            name={menu.icon}
            size={16}
            tintColorClassName="accent-header-foreground"
            type="monochrome"
          />
        </Pressable>
      ) : (
        <ScreenHeaderButton accessibilityLabel={menu.title} icon={menu.icon} />
      )}
    </ControlPillMenu>
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
          className="border-b border-header-border bg-header px-3 pb-2.5"
          style={{ paddingTop: Math.max(insets.top, 12), borderBottomWidth: 0 }}
        >
          <View className="min-h-12 flex-row items-center gap-2">
            {props.onBack ? (
              <Pressable
                accessibilityLabel="Navigate up"
                accessibilityRole="button"
                hitSlop={8}
                onPress={props.onBack}
                className="size-11 items-center justify-center"
              >
                <SymbolView
                  name="chevron.left"
                  size={24}
                  tintColorClassName="accent-header-foreground"
                  type="monochrome"
                />
              </Pressable>
            ) : null}
            <View className="min-h-11 flex-1 flex-row items-center gap-2.5 rounded-2xl bg-input px-3.5">
              <SymbolView
                name="magnifyingglass"
                size={17}
                tintColorClassName="accent-header-foreground"
                type="monochrome"
              />
              <TextInput
                accessibilityLabel={search.placeholder}
                autoCapitalize="none"
                onChangeText={search.onChangeText}
                value={search.value}
                placeholder={search.placeholder}
                placeholderTextColorClassName="accent-placeholder"
                className="flex-1 py-2 text-base font-sans text-header-foreground"
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
        <>
          {menuView}
          {props.trailing}
        </>
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
              className="absolute inset-0 bg-header px-2 pb-2"
              style={{ paddingTop: Math.max(insets.top, 12) }}
            >
              <View className="min-h-14 flex-1 flex-row items-center gap-1">
                <ScreenHeaderButton
                  accessibilityLabel={search.closeAccessibilityLabel ?? "Close search"}
                  icon="arrow.left"
                  onPress={closeSearch}
                />
                <MaterialSearchField
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
