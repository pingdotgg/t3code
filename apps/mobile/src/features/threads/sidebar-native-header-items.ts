import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { createNativeNavigationHistoryItems } from "../navigation/native-navigation-history-items";

type NativeHeaderMenuItems = NativeStackHeaderItemMenu["menu"]["items"];
type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

function toNativeHeaderMenuItems(items: HomeListFilterMenu["items"]): NativeHeaderMenuItems {
  return items.map((item) =>
    item.type === "action"
      ? {
          type: "action" as const,
          label: item.title,
          description: item.subtitle,
          onPress: item.onPress,
          state: item.state === "on" ? ("on" as const) : undefined,
        }
      : {
          type: "submenu" as const,
          label: item.title,
          items: toNativeHeaderMenuItems(item.items),
        },
  );
}

/**
 * Right-side UINavigationBar items for the sidebar column: navigation history,
 * the thread-list menu, and settings, sharing one Messages-style glass group.
 */
export function createSidebarHeaderItems(input: {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onOpenSettings: () => void;
}): NativeStackHeaderItem[] {
  return [
    ...createNativeNavigationHistoryItems({
      canGoBack: input.canGoBack,
      canGoForward: input.canGoForward,
      identifierPrefix: "sidebar-navigation",
      onBack: input.onBack,
      onForward: input.onForward,
    }),
    withNativeGlassHeaderItem({
      type: "menu",
      label: "",
      accessibilityLabel: "Filter and sort threads",
      icon: sfSymbolIcon(input.filterIcon),
      menu: {
        title: input.filterMenu.title,
        items: toNativeHeaderMenuItems(input.filterMenu.items),
      },
    }),
    withNativeGlassHeaderItem({
      type: "button",
      label: "",
      accessibilityLabel: "Open settings",
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
  ];
}
