import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { isValidElement, useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { KeyboardController, useKeyboardState } from "react-native-keyboard-controller";
import { isDuoDevice } from "../lib/device-type";
import { useMobileNavigationTheme } from "../lib/useMobileNavigationTheme";
import { useDeviceType, useNativeLayoutMetrics } from "../native/native-layout-metrics";
import {
  SearchBar,
  Stack,
  type HeaderBarButtonMailSearchToolbarItem,
  type SearchBarCommands,
  type StackHeaderConfigProps,
  type StackHeaderMinimizationBehaviorIOS,
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
  readonly unstable_headerMinimizationBehavior?: StackHeaderMinimizationBehaviorIOS;
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
        subtitle:
          ("subtitle" in item ? item.subtitle : undefined) ??
          ("description" in item ? item.description : undefined),
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
        return "flexible" in item && item.flexible === true
          ? { type: "spacer", id, sizing: "flexible" }
          : { type: "spacer", id, sizing: "fixed", width: item.spacing };
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
          title: item.label || item.accessibilityLabel || undefined,
          axisBehavior: item.axisBehavior,
          icon: convertIcon(item.icon),
          menu: item.disabled ? undefined : convertMenu(item.menu, `${id}:menu`),
          variant: item.variant,
          tintColor: item.tintColor,
          hidesSharedBackground: item.hidesSharedBackground,
        };
      case "button":
        return {
          type: "item",
          id,
          identifier: item.identifier,
          title: item.label || item.accessibilityLabel || undefined,
          axisBehavior: item.axisBehavior,
          icon: convertIcon(item.icon),
          onPress: item.disabled ? undefined : item.onPress,
          visibilityPriority:
            item.visibilityPriority === "default" ? "standard" : item.visibilityPriority,
          variant: item.variant,
          tintColor: item.tintColor,
          hidesSharedBackground: item.hidesSharedBackground,
        };
    }
  });
}

export function V5StackHeader(props: {
  readonly options: Options;
  readonly canGoBack: boolean;
  /** Workspace split columns share the vertical bar with the workspace tab bar. */
  readonly column?: "primary" | "detail";
  /** The workspace's compose action, shown as its own group in this column's bar. */
  readonly onCompose?: () => void;
}) {
  const { options } = props;
  const theme = useMobileNavigationTheme();
  const nativeMetrics = useNativeLayoutMetrics();
  const deviceType = useDeviceType();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
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
  const bottomSearch = Boolean(mailSearch) && deviceType !== "pad";
  // A vertical bar keeps fixed spaces at full length and separates items itself.
  const spacesSearch = bottomSearch && (nativeMetrics?.verticalBarEdge ?? "none") === "none";
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
      if (spacesSearch && bottom.length)
        bottom.push({ type: "spacer", id: "before-search", sizing: "fixed", width: 8 });
      bottom.push({ type: "item", id: "home-search", searchBarPlacement: true });
      if (spacesSearch && mailSearch.onComposePress)
        bottom.push({ type: "spacer", id: "after-search", sizing: "fixed", width: 8 });
    }
    if (mailSearch.onComposePress)
      bottom.push({
        type: "item",
        id: mailSearch.composeButtonId ?? "compose",
        identifier: "workspace-trailing-action",
        icon: { type: "sfSymbol", name: mailSearch.composeSystemImageName ?? "square.and.pencil" },
        onPress: mailSearch.onComposePress,
      });
  }
  // UIKit doesn't stack a column's toolbar against the workspace tab bar, which owns the
  // bottom of the vertical bar and draws over it. Those columns keep the group in their
  // navigation items. Integrated search stays in the column's horizontal bottom toolbar.
  if (
    props.column &&
    nativeMetrics &&
    nativeMetrics.verticalBarEdge !== "none" &&
    (props.column === "detail" ||
      (nativeMetrics.horizontalSizeClass === "compact" &&
        !toolbar.some((item) => item.type === "searchBarPlacement")))
  ) {
    if (trailing.length && bottom.length)
      trailing.push({ type: "spacer", id: "toolbar-group", sizing: "fixed", width: 8 });
    trailing.push(...bottom);
    bottom.length = 0;
  }
  if (props.onCompose) {
    const compose: HeaderItem = {
      type: "item",
      id: "workspace-compose",
      title: "New task",
      icon: { type: "sfSymbol", name: "square.and.pencil" },
      onPress: props.onCompose,
    };
    if (trailing.length)
      trailing.push({ type: "spacer", id: "compose-group", sizing: "fixed", width: 8 });
    trailing.push(compose);
  }
  // The vertical bar has no keyboard accessory row, so it carries its own dismiss. A regular-width
  // primary column draws a horizontal bar beside the detail column's vertical one. The first
  // trailing item sits at the bar's far end; the flexible space keeps it next to the keyboard.
  if (
    keyboardVisible &&
    nativeMetrics &&
    nativeMetrics.verticalBarEdge !== "none" &&
    (props.column !== "primary" || nativeMetrics.horizontalSizeClass === "compact")
  ) {
    trailing.unshift(
      {
        type: "item",
        id: "dismiss-keyboard",
        title: "Dismiss keyboard",
        icon: { type: "sfSymbol", name: "keyboard.chevron.compact.down" },
        onPress: () => void KeyboardController.dismiss(),
        // The folded bar is short; keep this out of the overflow menu.
        visibilityPriority: "high",
      },
      { type: "spacer", id: "dismiss-keyboard-space", sizing: "flexible" },
    );
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
  const autofocusRef = searchOptions?.ref ?? searchRef;
  // iOS ignores the native autoFocus prop, and SearchBar's imperative handle changes every
  // commit, so a ref callback would refocus on each render; focus once after the header mounts.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules a frame to focus the native SearchBar once after the header mounts, since iOS ignores autoFocus
  useEffect(() => {
    if (!searchOptions?.autoFocus) return;
    const frame = requestAnimationFrame(() => autofocusRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchOptions?.autoFocus, autofocusRef]);
  const titleStyle = StyleSheet.flatten(options.headerTitleStyle);
  const headerStyle = StyleSheet.flatten(options.headerStyle);
  const appearance = {
    // Clear colors remove UIKit material; let translucent bars supply their own blur background.
    backgroundColor: options.headerTransparent
      ? undefined
      : (headerStyle?.backgroundColor ?? theme.colors.card),
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
      title={title}
      subtitle={options.unstable_headerSubtitle ?? options.headerSubtitle}
      backButtonHidden={options.headerBackVisible === false}
      ios={{
        navigationItemStyle: options.unstable_navigationItemStyle,
        // Opt-ins apply only where the Duo is short: folded, or held landscape. The Duo
        // resolves `automatic` to minimize on scroll, so the tall unfolded display opts out.
        minimizationBehavior: !isDuoDevice(deviceType)
          ? undefined
          : deviceType === "duo-unfolded" &&
              nativeMetrics &&
              nativeMetrics.height > nativeMetrics.width
            ? "never"
            : options.unstable_headerMinimizationBehavior,
        tintColor: options.headerTintColor,
        searchBar:
          mailSearch || searchOptions ? (
            <SearchBar
              {...searchOptions}
              ref={searchOptions?.ref ?? searchRef}
              hideNavigationBar={false}
              hideWhenScrolling={false}
              allowToolbarIntegration={searchOptions?.allowToolbarIntegration ?? true}
              placement={bottomSearch ? "integrated" : (searchOptions?.placement ?? "automatic")}
              placeholder={mailSearch?.placeholder ?? searchOptions?.placeholder ?? "Search"}
              onFocus={(event) => {
                searchOptions?.onFocus?.(event);
              }}
              onChangeText={(event) => {
                mailSearch?.onSearchTextChange?.(event.nativeEvent.text);
                searchOptions?.onChangeText?.(event);
              }}
            />
          ) : undefined,
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
