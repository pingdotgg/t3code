import { Platform, Switch } from "react-native";

import { MaterialSwitch } from "./MaterialSwitch";
import type { ThemedSwitchProps } from "./MaterialSwitch.types";

export type { ThemedSwitchProps } from "./MaterialSwitch.types";

export function ThemedSwitch(props: ThemedSwitchProps) {
  if (Platform.OS === "android") {
    return <MaterialSwitch {...props} />;
  }

  return (
    <Switch
      {...props}
      ios_backgroundColorClassName="accent-switch-inactive-track"
      trackColorOffClassName="accent-switch-inactive-track"
      trackColorOnClassName="accent-switch-active-track"
    />
  );
}
