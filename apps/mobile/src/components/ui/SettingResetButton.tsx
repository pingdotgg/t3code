import { Pressable } from "react-native";

import { SymbolView } from "./AppSymbol";

export function SettingResetButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  if (props.disabled === true) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Reset ${props.label} to default`}
      accessibilityHint="Reset this setting to its default"
      accessibilityState={{ disabled: false }}
      disabled={false}
      onPress={props.onPress}
      className="-mr-3 size-12 items-center justify-center active:opacity-60"
      hitSlop={8}
    >
      <SymbolView
        name="arrow.uturn.backward"
        size={20}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
        weight="regular"
      />
    </Pressable>
  );
}
