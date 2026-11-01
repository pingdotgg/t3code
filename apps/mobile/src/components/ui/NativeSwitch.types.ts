import type { SwitchProps } from "react-native";

export type ThemedSwitchProps = Pick<
  SwitchProps,
  | "accessibilityHint"
  | "accessibilityLabel"
  | "disabled"
  | "onValueChange"
  | "style"
  | "testID"
  | "value"
>;
