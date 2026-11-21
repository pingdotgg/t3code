import { requireNativeView } from "expo";
import type { PropsWithChildren } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

import type { HardwareKeyboardCommand } from "../features/keyboard/hardwareKeyboardCommands";
import { defineNativePluginFeature } from "../plugins/features";
export const T3KeyboardCommands = defineNativePluginFeature(
  "native.native.t3-keyboard-commands",
  BuiltinT3KeyboardCommands,
);

interface NativeKeyboardCommandsProps extends ViewProps {
  readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>;
  readonly onCommand: (
    event: NativeSyntheticEvent<{ readonly command: HardwareKeyboardCommand }>,
  ) => void;
}

const NativeKeyboardCommands = requireNativeView<NativeKeyboardCommandsProps>("T3KeyboardCommands");

function BuiltinT3KeyboardCommands(
  props: PropsWithChildren<{
    readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>;
    readonly onCommand: (command: HardwareKeyboardCommand) => void;
  }>,
) {
  return (
    <NativeKeyboardCommands
      onCommand={(event) => props.onCommand(event.nativeEvent.command)}
      enabledCommands={props.enabledCommands}
      style={{ flex: 1 }}
    >
      {props.children}
    </NativeKeyboardCommands>
  );
}
