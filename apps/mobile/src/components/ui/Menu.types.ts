import type { MenuView } from "@react-native-menu/menu";
import type { ComponentProps, ReactNode } from "react";
import type { AccessibilityProps } from "react-native";

export type MenuProps = Omit<ComponentProps<typeof MenuView>, "children" | "themeVariant"> &
  Pick<AccessibilityProps, "accessible" | "accessibilityLabel" | "accessibilityRole"> & {
    readonly children: ReactNode;
    readonly className?: string;
  };
