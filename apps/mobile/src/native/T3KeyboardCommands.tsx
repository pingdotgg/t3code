import type { PropsWithChildren } from "react";
import { View } from "react-native";

import type { HardwareKeyboardCommand } from "../features/keyboard/hardwareKeyboardCommands";
import { defineNativePluginFeature } from "../plugins/features";
export const T3KeyboardCommands = defineNativePluginFeature(
  "native.native.t3-keyboard-commands",
  BuiltinT3KeyboardCommands,
);

function BuiltinT3KeyboardCommands(
  props: PropsWithChildren<{
    readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>;
    readonly onCommand: (command: HardwareKeyboardCommand) => void;
  }>,
) {
  return <View className="flex-1">{props.children}</View>;
}
