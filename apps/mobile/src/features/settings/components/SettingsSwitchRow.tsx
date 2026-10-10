import type { ComponentProps } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { SettingsControlRow } from "./SettingsControlRow";

export function SettingsSwitchRow(
  props: Omit<ComponentProps<typeof SettingsControlRow>, "children"> & {
    readonly value: boolean | null;
    readonly onValueChange: (value: boolean) => void;
  },
) {
  return (
    <SettingsControlRow
      disabled={props.disabled}
      icon={props.icon}
      label={props.label}
      subtitle={props.subtitle}
    >
      {props.value === null ? (
        <Pressable
          accessibilityLabel={`Set ${props.label} on for selected environments`}
          accessibilityRole="button"
          disabled={props.disabled}
          className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
          onPress={() => props.onValueChange(true)}
        >
          <Text className="text-sm font-t3-medium text-foreground">Mixed · Set on</Text>
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
