import type { ComponentProps } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { SettingsControlRow } from "./SettingsControlRow";

export function SettingsSwitchRow(
  props: Omit<ComponentProps<typeof SettingsControlRow>, "children"> & {
    readonly value: boolean | null;
    readonly mixedValue?: boolean;
    readonly onValueChange: (value: boolean) => void;
  },
) {
  const mixedValue = props.mixedValue ?? true;
  const mixedLabel = mixedValue ? "on" : "off";
  return (
    <SettingsControlRow
      disabled={props.disabled}
      icon={props.icon}
      label={props.label}
      subtitle={props.subtitle}
    >
      {props.value === null ? (
        <Pressable
          accessibilityLabel={`Set ${props.label} ${mixedLabel} for selected environments`}
          accessibilityRole="button"
          disabled={props.disabled}
          className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
          onPress={() => props.onValueChange(mixedValue)}
        >
          <Text className="text-sm font-t3-medium text-foreground">Mixed · Set {mixedLabel}</Text>
        </Pressable>
      ) : (
        <ThemedSwitch
          style={{ alignSelf: "center" }}
          accessibilityLabel={props.label}
          disabled={props.disabled}
          onValueChange={props.onValueChange}
          value={props.value}
        />
      )}
    </SettingsControlRow>
  );
}
