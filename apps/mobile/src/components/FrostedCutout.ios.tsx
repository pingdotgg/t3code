import { requireNativeView } from "expo";
import { StyleSheet, type ViewProps } from "react-native";

import type { FrostedCutoutProps } from "./FrostedCutout.types";

const NativeFrostedCutout = requireNativeView<ViewProps & FrostedCutoutProps>(
  "T3NativeControls",
  "FrostedCutout",
);

/** Fills its parent with one native blur that leaves a rounded hole clear. */
export function FrostedCutout(props: FrostedCutoutProps) {
  return <NativeFrostedCutout {...props} pointerEvents="none" style={StyleSheet.absoluteFill} />;
}
