import { type RefObject, use, useRef, useState } from "react";
import { Keyboard, type TextInputInstance, View } from "react-native";
import { useHardwareBack } from "../../lib/backHandler";
import { useToolbarLayout } from "./useToolbarLayout";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useSidebarToggle } from "../../features/layout/useSidebarToggle";
import { InspectorCloseContext } from "../../features/layout/inspector-bar-store";
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { AndroidHeaderIconButton, AndroidScreenHeader } from "./AndroidScreenHeader";
import { ScreenHeaderButton } from "./ScreenHeaderButton.android";
import { Menu } from "./Menu";
import { SearchField } from "./SearchField";
import { androidHeaderMenuActions, findHeaderMenuAction } from "./headerMenu.android";
import type { AppBarMenuItem, AppBarProps, AppBarSearch } from "./AppBar.types";
import { useHasWorkspaceAppBar, WorkspaceAppBar } from "./WorkspaceAppBar.android";

function selectMenuItem(items: ReadonlyArray<AppBarMenuItem>, id: string) {
  const action = findHeaderMenuAction(items, id);
  if (action && !action.disabled) action.onPress();
}

interface SearchState {
  readonly searching: boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly inputRef: RefObject<TextInputInstance | null>;
}

export function AppBar(props: AppBarProps) {
  return props.search ? (
    <SearchableAppBar {...props} search={props.search} />
  ) : (
    <AppBarView {...props} />
  );
}

// Only a bar with search registers for hardware back: its focus check needs a navigation
// context, and sheet headers such as Arrange threads render outside one.
function SearchableAppBar(props: AppBarProps & { readonly search: AppBarSearch }) {
  const { search } = props;
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<TextInputInstance>(null);
  const inline = search.mode === "inline";
  const controlled = search.active !== undefined;
  const searching =
    inline || (controlled ? search.active === true : searchOpen || search.value.length > 0);
  const open = () => {
    if (!controlled) setSearchOpen(true);
    search.onOpen?.();
    inputRef.current?.focus();
  };
  const close = () => {
    if (!controlled) {
      search.onChangeText("");
      setSearchOpen(false);
      Keyboard.dismiss();
    }
    search.onClose?.();
  };
  useHardwareBack(searching && !inline && !controlled, () => {
    close();
    return true;
  });
  return <AppBarView {...props} searchState={{ searching, open, close, inputRef }} />;
}

function AppBarView(props: AppBarProps & { readonly searchState?: SearchState }) {
  const { search, searchState } = props;
  const { paddingTop, paddingBottom } = useToolbarLayout(props.sheet);
  const { themeVariables } = useAppearancePreferences();
  const inWorkspace = useHasWorkspaceAppBar();
  const sidebarToggle = useSidebarToggle();
  const closeInspector = use(InspectorCloseContext);
  const inline = search?.mode === "inline";
  const searching = searchState?.searching === true;
  const openSearch = () => searchState?.open();
  const closeSearch = () => searchState?.close();

  const searchLabel = search?.accessibilityLabel ?? search?.placeholder ?? "";
  const searchField =
    search && searchState ? (
      <SearchField
        inputRef={searchState.inputRef}
        accessibilityLabel={searchLabel}
        clearAccessibilityLabel={search.clearAccessibilityLabel ?? "Clear search"}
        placeholder={
          search.compactToolbar
            ? (search.compactPlaceholder ?? search.placeholder)
            : search.placeholder
        }
        value={search.value}
        onChangeText={search.onChangeText}
        autoFocus={!inline}
      />
    ) : null;

  if (inWorkspace) {
    const menu = props.menus?.[0];
    const icon = typeof menu?.icon === "string" ? menu.icon : menu?.icon.android;
    return (
      <WorkspaceAppBar
        title={props.title}
        titleContent={props.titleContent}
        search={
          search
            ? {
                accessibilityLabel: searchLabel,
                active: searching,
                field: searchField,
                onOpen: openSearch,
                onClose: closeSearch,
              }
            : undefined
        }
        filter={
          menu
            ? {
                accessibilityLabel: menu.title,
                customized: icon?.endsWith(".fill") === true,
                actions: androidHeaderMenuActions(menu.items),
                onSelect: (id) => selectMenuItem(menu.items, id),
              }
            : undefined
        }
      />
    );
  }

  const menuView = props.menus?.map((menu) => (
    <Menu
      key={menu.title}
      actions={androidHeaderMenuActions(menu.items)}
      isAnchoredToRight
      title={menu.status ?? menu.title}
      onPressAction={({ nativeEvent }) => selectMenuItem(menu.items, nativeEvent.event)}
    >
      <ScreenHeaderButton accessibilityLabel={menu.title} icon={menu.icon} />
    </Menu>
  ));
  const options =
    props.embedded || props.sheet ? null : (
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
      titleContent={props.titleContent}
      subtitle={props.subtitle}
      onBack={props.onBack}
      leading={
        props.leading ??
        // Only a real button: any leading content takes the bar's navigation slot.
        (sidebarToggle && !props.sheet ? (
          <AndroidHeaderIconButton
            accessibilityLabel={sidebarToggle.accessibilityLabel}
            icon={sidebarToggle.icon}
            onPress={sidebarToggle.onPress}
          />
        ) : undefined)
      }
      embedded={props.sheet}
      hideBottomBorder={props.hideBottomBorder}
      compact={props.compact}
      actions={
        search && !inline
          ? [
              {
                accessibilityLabel: searchLabel,
                icon: "magnifyingglass",
                onPress: openSearch,
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
        menuView?.length || props.trailing || closeInspector ? (
          <>
            {menuView}
            {props.trailing}
            {closeInspector ? (
              <AndroidHeaderIconButton
                accessibilityLabel="Close inspector"
                icon="xmark"
                onPress={closeInspector}
              />
            ) : null}
          </>
        ) : undefined
      }
    />
  );
  if (!search) {
    return (
      <>
        {options}
        {header}
      </>
    );
  }
  return (
    <>
      {options}
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
            // Match Material TopAppBar's 4dp icon inset so buttons stay where the bar drew them.
            style={{ paddingTop, paddingBottom, paddingHorizontal: 4 }}
          >
            <View className="flex-1 flex-row items-center gap-1">
              {inline ? (
                props.onBack ? (
                  <ScreenHeaderButton
                    accessibilityLabel="Navigate up"
                    icon="arrow.left"
                    onPress={props.onBack}
                  />
                ) : null
              ) : (
                <ScreenHeaderButton
                  accessibilityLabel={search.closeAccessibilityLabel ?? "Close search"}
                  icon="arrow.left"
                  onPress={closeSearch}
                />
              )}
              {searchField}
              {inline ? menuView : null}
            </View>
          </View>
        ) : null}
      </View>
    </>
  );
}
