import { MenuView, type MenuAction } from "@react-native-menu/menu";
import type { ComponentProps, ReactNode } from "react";
import { Platform, Pressable, useColorScheme, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import { cn } from "../lib/cn";
import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
  readonly variant?: "circle" | "pill" | "primary" | "danger";
  readonly disabled?: boolean;
}) {
  const variant = props.variant ?? "circle";

  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const iconTintColor =
    variant === "primary"
      ? props.disabled
        ? iconSubtle
        : primaryFg
      : variant === "danger"
        ? dangerFg
        : iconColor;

  const isCircle =
    variant === "circle" || variant === "danger" || (variant === "primary" && !props.label);
  const containerClassName = cn(
    isCircle
      ? "h-11 w-11 items-center justify-center rounded-full"
      : variant === "primary"
        ? "h-11 flex-row items-center justify-center gap-2 rounded-full px-5"
        : "h-11 flex-row items-center justify-center gap-2 rounded-full px-3.5",
    variant === "primary"
      ? props.disabled
        ? "bg-subtle-strong"
        : "bg-primary"
      : variant === "danger"
        ? "bg-danger"
        : "bg-subtle",
  );
  const labelClassName = cn(
    "text-center text-xs font-t3-bold",
    variant === "primary"
      ? props.disabled
        ? "text-foreground-muted"
        : "text-primary-foreground"
      : "",
  );

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      onPress={props.onPress}
      disabled={props.disabled}
      className={containerClassName}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView name={props.icon} size={16} tintColor={iconTintColor} type="monochrome" />
      ) : null}
      {props.label ? <Text className={labelClassName}>{props.label}</Text> : null}
    </Pressable>
  );
}

/**
 * Android renders checkable menu rows with a square CheckBox widget. Replace
 * the checkable state with a check glyph (the plugin-provided drawable) on the
 * selected item so all selector menus show a plain check icon instead.
 */
function withAndroidSelectionIcons(
  actions: ReadonlyArray<MenuAction> | undefined,
  checkColor: string,
): MenuAction[] | undefined {
  if (!actions) {
    return undefined;
  }
  return actions.map((action) => ({
    ...action,
    state: undefined,
    ...(action.state === "on" ? { image: "ic_menu_check", imageColor: checkColor } : {}),
    subactions: withAndroidSelectionIcons(action.subactions, checkColor),
  }));
}

export function ControlPillMenu(
  props: Omit<ComponentProps<typeof MenuView>, "children" | "themeVariant"> & {
    readonly children: ReactNode;
  },
) {
  const isDarkMode = useColorScheme() === "dark";
  const foregroundColor = useThemeColor("--color-foreground");
  const actions =
    Platform.OS === "android"
      ? (withAndroidSelectionIcons(props.actions, foregroundColor as string) ?? [])
      : props.actions;

  return (
    <MenuView {...props} actions={actions} themeVariant={isDarkMode ? "dark" : "light"}>
      {props.children}
    </MenuView>
  );
}
