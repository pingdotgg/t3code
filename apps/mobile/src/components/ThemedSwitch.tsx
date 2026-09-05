import { Platform, Switch, type SwitchProps } from "react-native";

export function ThemedSwitch(props: SwitchProps) {
  return (
    <Switch
      {...props}
      ios_backgroundColorClassName="accent-switch-inactive-track"
      thumbColorClassName={
        Platform.OS === "android"
          ? props.value
            ? "accent-switch-active-thumb"
            : "accent-switch-inactive-thumb"
          : undefined
      }
      trackColorOffClassName="accent-switch-inactive-track"
      trackColorOnClassName="accent-switch-active-track"
    />
  );
}
