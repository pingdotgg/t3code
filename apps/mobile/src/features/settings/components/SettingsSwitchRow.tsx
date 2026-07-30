import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import { Switch, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsSwitchRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  const icon = useThemeColor("--color-icon");
  const activeTrack = String(useThemeColor("--color-switch-active"));
  const track = String(useThemeColor("--color-secondary-border"));

  return (
    <View
      className="flex-row items-center gap-4 p-4"
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      <SymbolView name={props.icon} size={22} tintColor={icon} type="monochrome" weight="regular" />
      <Text className="flex-1 text-lg text-foreground">{props.label}</Text>
      <Switch
        disabled={props.disabled}
        ios_backgroundColor={track}
        onValueChange={props.onValueChange}
        trackColor={{ false: track, true: activeTrack }}
        value={props.value}
      />
    </View>
  );
}
