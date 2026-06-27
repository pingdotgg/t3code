import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

export type SidebarFilterButtonIcon =
  | "line.3.horizontal.decrease.circle"
  | "line.3.horizontal.decrease.circle.fill";

export function SidebarFilterButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: SidebarFilterButtonIcon;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const pressedBackgroundColor = useThemeColor("--color-subtle");

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: pressed ? pressedBackgroundColor : "transparent" },
      ]}
    >
      <SymbolView name={props.icon} size={18} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
});
