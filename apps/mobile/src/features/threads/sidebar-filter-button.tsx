import { SymbolView } from "../../components/AppSymbol";
import { Pressable } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

export type SidebarFilterButtonIcon =
  | "line.3.horizontal.decrease.circle"
  | "line.3.horizontal.decrease.circle.fill";

export function SidebarFilterButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: SidebarFilterButtonIcon;
}) {
  const iconColor = useThemeColor("--color-foreground");

  return (
    <Pressable
      className="size-11 cursor-pointer items-center justify-center rounded-full bg-subtle active:opacity-70"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
    >
      <SymbolView name={props.icon} size={16} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}
