import { requireNativeView } from "expo";
import type { ViewProps } from "react-native";

const NativeSheetSize = requireNativeView<ViewProps & { contentHeight: number }>(
  "T3NativeControls",
  "ContextSheetSize",
);

export function ContextSheetSize({ height }: { height: number }) {
  return (
    <NativeSheetSize
      contentHeight={height}
      pointerEvents="none"
      style={{ position: "absolute", width: 0, height: 0 }}
    />
  );
}
