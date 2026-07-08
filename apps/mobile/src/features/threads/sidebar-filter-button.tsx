import { SymbolView } from "../../components/AppSymbol";
import { Pressable, StyleSheet, useColorScheme } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

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
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const idleBackgroundColor =
    colorScheme === "dark" ? "rgba(118,118,128,0.24)" : "rgba(255,255,255,0.72)";
  const borderColor = colorScheme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        props.grouped
          ? { backgroundColor: pressed ? pressedBackgroundColor : "transparent", borderWidth: 0 }
          : {
              backgroundColor: pressed ? pressedBackgroundColor : idleBackgroundColor,
              borderColor,
            },
      ]}
    >
      <SymbolView name={props.icon} size={20} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    // Match the native glass UIBarButtonItem group metrics (~50pt slots,
    // 44pt bar height, label-colored ~20pt glyphs).
    width: 50,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
});
