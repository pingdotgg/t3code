import { useRef, useState } from "react";
import { Keyboard, type TextInputInstance, View } from "react-native";
import { useHardwareBack } from "../../lib/backHandler";
import { useToolbarLayout } from "./useToolbarLayout";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidWorkspaceSidebarButton } from "../../features/layout/workspace-sidebar-toolbar";
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { AndroidScreenHeader } from "./AndroidScreenHeader";
import { ScreenHeaderButton } from "./ScreenHeaderButton.android";
import { Menu } from "./Menu";
import { SearchField } from "./SearchField";
import { androidHeaderMenuActions, findHeaderMenuAction } from "./headerMenu.android";
import type { AppBarProps } from "./AppBar.types";

export function AppBar(props: AppBarProps) {
  const { search } = props;
  const { paddingTop, paddingBottom } = useToolbarLayout();
  const { themeVariables } = useAppearancePreferences();
  const inputRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = search !== undefined && (searchOpen || search.value.length > 0);
  const onSearchChange = search?.onChangeText;
  const closeSearch = () => {
    onSearchChange?.("");
    setSearchOpen(false);
    Keyboard.dismiss();
  };
  useHardwareBack(searching, () => {
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
      <ScreenHeaderButton accessibilityLabel={menu.title} icon={menu.icon} />
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
