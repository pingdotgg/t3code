import { SymbolView } from "../../components/AppSymbol";
import { Pressable, StyleSheet } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";
import { useAppearanceColorScheme } from "../../lib/useAppearanceColorScheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export type SidebarFilterButtonIcon =
  | "line.3.horizontal.decrease.circle"
  | "line.3.horizontal.decrease.circle.fill";

export function SidebarFilterButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: SidebarFilterButtonIcon;
  /** Rendered inside a shared capsule group — no own background/border. */
  readonly grouped?: boolean;
}) {
  const iconColor = useThemeColor("--color-foreground");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const colorScheme = useAppearanceColorScheme() === "dark" ? "dark" : "light";
  const { themeColors } = useAppearancePreferences();
  const idleBackgroundColor =
    themeColors?.surfaceOverlay ??
    (colorScheme === "dark" ? "rgba(118,118,128,0.24)" : "rgba(255,255,255,0.72)");
  const borderColor =
    themeColors?.border ?? (colorScheme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)");

  return (
    <Pressable
      className="h-11 w-[50px] cursor-pointer items-center justify-center rounded-[22px]"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      style={({ pressed }) => [
        props.grouped
          ? { backgroundColor: pressed ? pressedBackgroundColor : "transparent", borderWidth: 0 }
          : {
              backgroundColor: pressed ? pressedBackgroundColor : idleBackgroundColor,
              borderColor,
              borderWidth: StyleSheet.hairlineWidth,
            },
      ]}
    >
      <SymbolView name={props.icon} size={20} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}
