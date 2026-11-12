import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";

import type { AppBarMenuItem } from "../../../components/ui/AppBar.types";
import { withNativeGlassHeaderItem } from "../native-glass-header-items";

type NativeHeaderMenuItems = NativeStackHeaderItemMenu["menu"]["items"];
type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

function toNativeHeaderMenuItems(items: ReadonlyArray<AppBarMenuItem>): NativeHeaderMenuItems {
  return items.map((item) =>
    "items" in item
      ? {
          type: "submenu" as const,
          label: item.title ?? "",
          items: toNativeHeaderMenuItems(item.items),
        }
      : {
          type: "action" as const,
          label: item.title,
          description: item.subtitle,
          onPress: item.onPress,
          state: item.selected ? ("on" as const) : undefined,
        },
  );
}

/** The sidebar column's bar items, as native header items so the title can size around them. */
export function createWorkspaceListHeaderItems(input: {
  readonly filter: {
    readonly accessibilityLabel: string;
    readonly icon: string;
    readonly title: string;
    readonly items: ReadonlyArray<AppBarMenuItem>;
  };
  readonly onOpenSettings?: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "menu",
      axisBehavior: "horizontalOnly",
      label: "",
      accessibilityLabel: input.filter.accessibilityLabel,
      icon: sfSymbolIcon(input.filter.icon),
      menu: {
        title: input.filter.title,
        items: toNativeHeaderMenuItems(input.filter.items),
      },
    }),
    ...(input.onOpenSettings
      ? [
          withNativeGlassHeaderItem({
            type: "button",
            axisBehavior: "horizontalOnly",
            label: "Settings",
            accessibilityLabel: "Open settings",
            icon: sfSymbolIcon("gearshape"),
            onPress: input.onOpenSettings,
          }),
        ]
      : []),
  ];
}
