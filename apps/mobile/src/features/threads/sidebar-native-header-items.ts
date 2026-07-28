import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

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
 * Right-side UINavigationBar items for the sidebar column: the thread list
 * filter/sort menu plus the settings button, sharing one glass capsule —
 * the Messages-style grouped header buttons.
 */
export function createSidebarHeaderItems(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly workspace: "work" | "code";
  readonly onWorkspaceChange: (workspace: "work" | "code") => void;
  readonly onOpenSettings: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "menu",
      label: "",
      accessibilityLabel: `Switch workspace. Current workspace: T3 ${input.workspace === "work" ? "Work" : "Code"}`,
      icon: sfSymbolIcon("rectangle.2.swap"),
      menu: {
        title: "Workspace",
        items: [
          {
            type: "action" as const,
            label: "T3 Work",
            description: "Create, learn, and explore",
            state: input.workspace === "work" ? ("on" as const) : undefined,
            onPress: () => input.onWorkspaceChange("work"),
          },
          {
            type: "action" as const,
            label: "T3 Code",
            description: "Build, debug, and ship",
            state: input.workspace === "code" ? ("on" as const) : undefined,
            onPress: () => input.onWorkspaceChange("code"),
          },
        ],
      },
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
