import type { MenuAction, MenuView } from "@react-native-menu/menu";
import type { ComponentProps, ReactNode } from "react";
import type { AccessibilityProps } from "react-native";

export type MenuProps = Omit<ComponentProps<typeof MenuView>, "children" | "themeVariant"> &
  Pick<AccessibilityProps, "accessible" | "accessibilityLabel" | "accessibilityRole"> & {
    readonly children: ReactNode;
    readonly className?: string;
  };

/** Android's in-app menus also draw `renderIcon` in the icon slot, such as a project's favicon. */
export type MenuItemAction = Omit<MenuAction, "subactions"> & {
  readonly renderIcon?: ((size: number) => ReactNode) | undefined;
  readonly subactions?: MenuItemAction[];
};
