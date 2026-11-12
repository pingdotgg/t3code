import { Platform, Switch } from "react-native";

import { NativeSwitch } from "./NativeSwitch";
import type { ThemedSwitchProps } from "./NativeSwitch.types";

export type { ThemedSwitchProps } from "./NativeSwitch.types";

export function ThemedSwitch(props: ThemedSwitchProps) {
  if (Platform.OS === "android") {
    return <NativeSwitch {...props} />;
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
