import type { ComponentProps } from "react";

import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { SettingsControlRow } from "./SettingsControlRow";

export function SettingsSwitchRow(
  props: Omit<ComponentProps<typeof SettingsControlRow>, "children"> & {
    readonly value: boolean;
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
      <ThemedSwitch
        style={{ alignSelf: "center" }}
        accessibilityLabel={props.label}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </SettingsControlRow>
  );
}
