import { defineNativePluginFeature } from "../../plugins/features";
import { Platform, Switch } from "react-native";

import { NativeSwitch } from "./NativeSwitch";
import type { ThemedSwitchProps } from "./NativeSwitch.types";

export type { ThemedSwitchProps } from "./NativeSwitch.types";

function BuiltinThemedSwitch(props: ThemedSwitchProps) {
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

export const ThemedSwitch = defineNativePluginFeature(
  "native.components.ui.themed-switch",
  BuiltinThemedSwitch,
);
