import { SymbolView } from "../../components/AppSymbol";
import { Pressable, StyleSheet } from "react-native";

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
  const idleBackgroundColor = useThemeColor("--color-glass-surface");
  const borderColor = useThemeColor("--color-header-border");

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
