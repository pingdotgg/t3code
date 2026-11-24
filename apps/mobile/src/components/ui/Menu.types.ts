import type { MenuView } from "@react-native-menu/menu";
import type { ComponentProps, ReactNode } from "react";
import type { ViewProps } from "react-native";

export type MenuProps = Omit<ComponentProps<typeof MenuView>, "children" | "themeVariant"> &
  Pick<
    ViewProps,
    | "accessible"
    | "accessibilityActions"
    | "accessibilityHint"
    | "accessibilityLabel"
    | "accessibilityRole"
    | "accessibilityState"
    | "onAccessibilityAction"
  > & {
    readonly children: ReactNode;
    readonly className?: string;
  };
