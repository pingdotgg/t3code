import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { isValidElement, useRef } from "react";
import { Platform, StyleSheet } from "react-native";
import { useMobileNavigationTheme } from "../lib/useMobileNavigationTheme";
import { useNativeLayoutMetrics } from "../features/layout/native-layout-metrics";
import {
  SearchBar,
  Stack,
  type HeaderBarButtonMailSearchToolbarItem,
  type SearchBarCommands,
  type StackHeaderConfigProps,
  type StackHeaderMenuElementIOS,
  type StackHeaderMenuIOS,
  type HeaderBarButtonItemWithMenu,
  type HeaderBarButtonSearchBarPlacementItem,
} from "react-native-screens";

type HeaderItem = NonNullable<NonNullable<StackHeaderConfigProps["ios"]>["leadingItems"]>[number];
type ToolbarItem =
  | NativeStackHeaderItem
  | HeaderBarButtonMailSearchToolbarItem
  | HeaderBarButtonSearchBarPlacementItem;
type Options = NativeStackNavigationOptions & {
  readonly unstable_navigationItemStyle?: "editor" | "navigator";
  readonly headerSubtitle?: string;
  readonly unstable_headerSubtitle?: string;
  readonly headerSubtitleStyle?: { color?: string; fontSize?: number; fontFamily?: string };
  readonly unstable_headerCenterItems?: () => NativeStackHeaderItem[];
  readonly unstable_headerToolbarItems?: () => ToolbarItem[];
};

type MenuElementInput =
  | NativeStackHeaderItemMenu["menu"]["items"][number]
  | HeaderBarButtonItemWithMenu["menu"]["items"][number];
type MenuInput = { readonly title?: string; readonly items: readonly MenuElementInput[] };

function convertIcon(
  icon:
    | Extract<NativeStackHeaderItem, { type: "button" }>["icon"]
    | HeaderBarButtonItemWithMenu["icon"],
) {
  if (!icon) return undefined;
  if (icon.type === "image")
    return icon.tinted === false
      ? { type: "imageSource" as const, imageSource: icon.source }
      : { type: "templateSource" as const, templateSource: icon.source };
  return icon;
}

function convertMenu(menu: MenuInput, id: string): StackHeaderMenuIOS {
  const children = menu.items.flatMap<StackHeaderMenuElementIOS>((item, index) => {
    if ("hidden" in item && item.hidden) return [];
    const childId = `${id}:${index}`;
    if (item.type === "submenu") {
      return [
        {
          ...convertMenu({ items: item.items }, childId),
          title: "label" in item ? item.label : item.title,
          displayInline:
            "inline" in item
              ? item.inline
              : "displayInline" in item
                ? item.displayInline
                : undefined,
        },
      ];
    }
    // Use actions even for checked entries: the app owns their durable state.
    return [
      {
        id: childId,
        type: "menuItem" as const,
        itemType: "action" as const,
        title: "label" in item ? item.label : item.title,
        icon: convertIcon(item.icon),
        onPress: item.disabled ? undefined : item.onPress,
        keepsMenuPresented: item.keepsMenuPresented,
        disabled: item.disabled,
        destructive: item.destructive,
        subtitle: "subtitle" in item ? item.subtitle : undefined,
        state: item.state,
      },
    ];
  });
  return { id, type: "menu", title: menu.title, children };
}

function convertItems(items: NativeStackHeaderItem[], prefix: string): HeaderItem[] {
  return items.map((item, index): HeaderItem => {
    const id =
      item.type === "spacing" ? `${prefix}:${index}` : (item.identifier ?? `${prefix}:${index}`);
    switch (item.type) {
      case "spacing":
        return { type: "spacer", id, sizing: "fixed", width: item.spacing };
      case "custom":
        return {
          type: "item",
          id,
          render: () => item.element,
          hidesSharedBackground: item.hidesSharedBackground,
        };
      case "menu":
        return {
          type: "item",
          id,
          identifier: item.identifier,
          title: item.label || undefined,
          axisBehavior: item.axisBehavior,
          icon: convertIcon(item.icon),
          menu: convertMenu(item.menu, `${id}:menu`),
          hidesSharedBackground: item.hidesSharedBackground,
        };
      case "button":
        return {
          type: "item",
          id,
          identifier: item.identifier,
          title: item.label || undefined,
          axisBehavior: item.axisBehavior,
          icon: convertIcon(item.icon),
          onPress: item.disabled ? undefined : item.onPress,
          hidesSharedBackground: item.hidesSharedBackground,
        };
    }
  });
}

/** Translate the existing screen options to v5's native header API. */
export function V5StackHeader(props: {
  readonly options: Options;
  readonly canGoBack: boolean;
  readonly primary?: boolean;
}) {
  const { options } = props;
  const theme = useMobileNavigationTheme();
  const nativeMetrics = useNativeLayoutMetrics();
  const searchRef = useRef<SearchBarCommands>(null);
  const itemProps = { tintColor: options.headerTintColor, canGoBack: props.canGoBack };
  const leading = convertItems(options.unstable_headerLeftItems?.(itemProps) ?? [], "leading");
  const trailing = convertItems(
    [
      ...(options.unstable_headerCenterItems?.() ?? []),
      ...(options.unstable_headerRightItems?.(itemProps) ?? []),
    ],
    "trailing",
  );
  const toolbar = options.unstable_headerToolbarItems?.() ?? [];
  const mailSearch = toolbar.find(
    (item): item is HeaderBarButtonMailSearchToolbarItem => item.type === "mailSearchToolbar",
  );
  const bottomSearch = Boolean(mailSearch) && Platform.OS === "ios" && !Platform.isPad;
  const bottom = toolbar.flatMap<HeaderItem>((item, index) => {
    if (item.type === "mailSearchToolbar") return [];
    if (item.type === "searchBarPlacement")
      return [{ type: "item", id: `toolbar-search:${index}`, searchBarPlacement: true }];
    return convertItems([item], `toolbar:${index}`);
  });
  if (mailSearch) {
    if (mailSearch.filterMenu)
      bottom.push({
        type: "item",
        id: mailSearch.filterButtonId ?? "filter",
        icon: {
          type: "sfSymbol",
          name: mailSearch.filterSystemImageName ?? "line.3.horizontal.decrease",
        },
        menu: convertMenu(mailSearch.filterMenu, "filter-menu"),
      });
    if (bottomSearch) {
      if (bottom.length)
        bottom.push({ type: "spacer", id: "before-search", sizing: "fixed", width: 8 });
      bottom.push({ type: "item", id: "home-search", searchBarPlacement: true });
      if (mailSearch.onComposePress)
        bottom.push({ type: "spacer", id: "after-search", sizing: "fixed", width: 8 });
    }
    if (mailSearch.onComposePress)
      bottom.push({
        type: "item",
        id: mailSearch.composeButtonId ?? "compose",
        icon: { type: "sfSymbol", name: mailSearch.composeSystemImageName ?? "square.and.pencil" },
        onPress: mailSearch.onComposePress,
      });
  }
  // The Duo's vertical navigation bar owns these actions. UIKit keeps the
  // primary column's navigation items beside its title and the detail's in
  // the rail; a conventional UIToolbar can otherwise leave them inaccessible.
  if (nativeMetrics && nativeMetrics.verticalBarEdge !== "none") {
    trailing.push(...bottom);
    bottom.length = 0;
  }
  const left = options.headerLeft?.(itemProps);
  const right = options.headerRight?.(itemProps);
  if (!options.unstable_headerLeftItems && isValidElement(left))
    leading.push({ type: "item", id: "custom-left", render: () => left });
  if (!options.unstable_headerRightItems && isValidElement(right))
    trailing.push({ type: "item", id: "custom-right", render: () => right });
  const title = typeof options.headerTitle === "string" ? options.headerTitle : options.title;
  const titleElement =
    typeof options.headerTitle === "function"
      ? options.headerTitle({ children: title ?? "", tintColor: options.headerTintColor })
      : undefined;
  const searchOptions = options.headerSearchBarOptions;
  const titleStyle = StyleSheet.flatten(options.headerTitleStyle);
  const headerStyle = StyleSheet.flatten(options.headerStyle);
  const appearance = {
    backgroundColor:
      headerStyle?.backgroundColor ??
      (options.headerTransparent ? "transparent" : theme.colors.card),
    shadowColor: options.headerShadowVisible === false ? "transparent" : undefined,
    titleFontSize: titleStyle?.fontSize,
    titleFontFamily: titleStyle?.fontFamily,
    titleFontWeight: titleStyle?.fontWeight,
    titleFontColor: titleStyle?.color,
    subtitleFontSize: options.headerSubtitleStyle?.fontSize,
    subtitleFontColor: options.headerSubtitleStyle?.color,
  };
  return (
    <Stack.HeaderConfig
      hidden={options.headerShown === false}
      transparent={options.headerTransparent}
      editorStyle={options.unstable_navigationItemStyle === "editor"}
      title={title}
      subtitle={options.unstable_headerSubtitle ?? options.headerSubtitle}
      backButtonHidden={options.headerBackVisible === false}
      searchBar={
        mailSearch || searchOptions ? (
          <SearchBar
            {...searchOptions}
            ref={searchOptions?.ref ?? searchRef}
            hideNavigationBar={false}
            hideWhenScrolling={false}
            allowToolbarIntegration={searchOptions?.allowToolbarIntegration ?? true}
            placement={bottomSearch ? "integrated" : (searchOptions?.placement ?? "automatic")}
            placeholder={mailSearch?.placeholder ?? searchOptions?.placeholder ?? "Search"}
            onChangeText={(event) => {
              mailSearch?.onSearchTextChange?.(event.nativeEvent.text);
              searchOptions?.onChangeText?.(event);
            }}
          />
        ) : undefined
      }
      ios={{
        toolbarItems: bottom,
        leadingItems: leading,
        trailingItems: trailing,
        titleItem: isValidElement(titleElement)
          ? { id: "title", render: () => titleElement }
          : undefined,
        largeTitleEnabled: options.headerLargeTitle,
        backButtonDisplayMode: options.headerBackButtonDisplayMode ?? "minimal",
        backButtonMenuEnabled: options.headerBackButtonMenuEnabled ?? true,
        backButtonTitle: options.headerBackTitle,
        standardAppearance: appearance,
        scrollEdgeAppearance: appearance,
      }}
    />
  );
}
