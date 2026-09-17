import { Pressable } from "react-native";

import { SymbolView, type AppSymbolName } from "./AppSymbol";

export function MaterialIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly variant?: "standard" | "primary" | "tonal" | "danger";
}) {
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled), selected: props.selected }}
      className="size-12 items-center justify-center"
    >
      <SymbolView name={props.icon} size={24} tintColorClassName="accent-foreground" />
    </Pressable>
  );
}
