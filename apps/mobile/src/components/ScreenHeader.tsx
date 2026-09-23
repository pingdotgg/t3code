import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";
import { useId } from "react";
import { createNativeHeaderMenu } from "./nativeHeaderMenu.ios";
import { ScreenHeaderButton } from "./ScreenHeaderButton";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../native/StackHeader";
import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "../native/NativeWorkspaceColumns";
import { useAdaptiveWorkspaceLayout } from "../features/layout/AdaptiveWorkspaceLayout";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../features/layout/native-mail-search-toolbar";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { ScreenHeaderMenuItem, ScreenHeaderProps } from "./ScreenHeader.types";
import type { AppSymbolName } from "./AppSymbol";
import { useNativeMailSearchToolbar } from "../features/layout/use-native-mail-search-toolbar";

function iosIcon(icon: AppSymbolName) {
  return typeof icon === "string" ? icon : icon.ios;
}

type MailMenu = NonNullable<HeaderBarButtonMailSearchToolbarItem["filterMenu"]>;
function mailMenuItems(items: ReadonlyArray<ScreenHeaderMenuItem>): MailMenu["items"] {
  return items.map((item) =>
    "items" in item
      ? { type: "submenu", title: item.title ?? "", items: mailMenuItems(item.items) }
      : {
          type: "action",
          title: item.title,
          state: item.selected ? "on" : "off",
          disabled: item.disabled,
          onPress: item.onPress,
        },
  );
}

export function ScreenHeader(props: ScreenHeaderProps) {
  const headerId = useId();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const { themeVariables } = useAppearancePreferences();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const { search, menus } = props;
  const menu = menus?.[0];
  const compactSearch =
    search !== undefined &&
    (search.compactToolbar ?? !layout.usesSplitView) &&
    usesNativeMailSearchToolbar;
  const visibleMenus = compactSearch ? (menus?.slice(1) ?? []) : (menus ?? []);
  const refresh = search?.refreshInToolbar ? search.onRefresh : undefined;
  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[
          props.optionsVersion,
          compactSearch ? menu : undefined,
          compactSearch ? refresh : undefined,
        ]}
        options={{
          headerShown: true,
          headerBackVisible:
            !layout.usesSplitView ||
            !props.backInSplitView ||
            !(props.backInSplitView.onPress || props.onBack),
          title: props.title,
          unstable_headerSubtitle: props.subtitle || undefined,
          ...(props.matchSearchSurface
            ? { contentStyle: { backgroundColor: themeVariables["--color-sheet-solid"] } }
            : undefined),
          ...(search
            ? {
                unstable_headerToolbarItems: compactSearch
                  ? () => [
                      createNativeMailSearchToolbarItem({
                        showsSearchDismissButton: true,
                        placeholder: search.compactPlaceholder ?? search.placeholder,
                        onSearchTextChange: search.onChangeText,
                        searchTextChangeId: `${headerId}-search-text`,
                        ...(refresh
                          ? {
                              composeButtonId: `${headerId}-refresh`,
                              composeSystemImageName: "arrow.clockwise",
                              onComposePress: refresh,
                            }
                          : undefined),
                        ...(menu
                          ? {
                              filterButtonId: `${headerId}-filter`,
                              filterSystemImageName: iosIcon(menu.icon),
                              filterMenu: { title: menu.title, items: mailMenuItems(menu.items) },
                            }
                          : undefined),
                      }),
                    ]
                  : () => [],
                headerSearchBarOptions: compactSearch
                  ? undefined
                  : {
                      allowToolbarIntegration: true,
                      ...(NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED && search.mode === "inline"
                        ? { placement: "integratedButton" as const }
                        : undefined),
                      autoCapitalize: "none",
                      hideNavigationBar: false,
                      ...(search.mode === "inline" ? { obscureBackground: false } : undefined),
                      placeholder: search.placeholder,
                      onChangeText: (event) => search.onChangeText(event.nativeEvent.text),
                      onCancelButtonPress: () => search.onChangeText(""),
                    },
              }
            : undefined),
          ...props.options,
        }}
      />
      {layout.usesSplitView && (props.sidebar !== false || props.backInSplitView) ? (
        <NativeHeaderToolbar placement="left">
          {props.backInSplitView && (props.backInSplitView.onPress || props.onBack) ? (
            <ScreenHeaderButton
              {...props.backInSplitView}
              onPress={props.backInSplitView.onPress ?? props.onBack}
            />
          ) : null}
          {props.sidebar !== false &&
          (!NATIVE_WORKSPACE_COLUMNS_SUPPORTED || !panes.primarySidebarVisible) ? (
            <ScreenHeaderButton
              axisBehavior={NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? "horizontalOnly" : undefined}
              accessibilityLabel={
                panes.primarySidebarVisible
                  ? `Maximize ${props.title.toLowerCase()}`
                  : "Show threads"
              }
              icon={
                panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"
              }
              onPress={togglePrimarySidebar}
              separateBackground={
                props.backInSplitView ? props.backInSplitView.separateBackground : true
              }
            />
          ) : null}
        </NativeHeaderToolbar>
      ) : null}
      {(props.actions?.length ||
        (!compactSearch && refresh) ||
        visibleMenus.length ||
        props.trailing) &&
      props.options?.unstable_headerRightItems === undefined ? (
        <NativeHeaderToolbar placement="right">
          {props.actions?.map((action) => (
            <ScreenHeaderButton
              key={action.accessibilityLabel}
              {...action}
              icon={iosIcon(action.icon)}
              separateBackground
            />
          ))}
          {refresh && !compactSearch ? (
            <ScreenHeaderButton
              accessibilityLabel={search?.refreshAccessibilityLabel}
              icon="arrow.clockwise"
              onPress={refresh}
              separateBackground
            />
          ) : null}
          {visibleMenus.map(createNativeHeaderMenu)}
          {props.trailing}
        </NativeHeaderToolbar>
      ) : null}
    </>
  );
}

export type {
  ScreenHeaderAction,
  ScreenHeaderMenu,
  ScreenHeaderMenuItem,
  ScreenHeaderProps,
  ScreenHeaderSearch,
} from "./ScreenHeader.types";
