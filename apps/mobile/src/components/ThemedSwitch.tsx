import { Platform, Switch, type SwitchProps } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";

export function ThemedSwitch(props: SwitchProps) {
  const activeTrack = String(useThemeColor("--color-switch-active-track"));
  const inactiveTrack = String(useThemeColor("--color-switch-inactive-track"));
  const activeThumb = String(useThemeColor("--color-switch-active-thumb"));
  const inactiveThumb = String(useThemeColor("--color-switch-inactive-thumb"));

  return (
    <Switch
      {...props}
      ios_backgroundColor={inactiveTrack}
      thumbColor={
        Platform.OS === "android" ? (props.value ? activeThumb : inactiveThumb) : undefined
      }
      trackColor={{ false: inactiveTrack, true: activeTrack }}
    />
  );
}
