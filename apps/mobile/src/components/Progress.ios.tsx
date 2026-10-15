import { ProgressView } from "@expo/ui/swift-ui";
import { progressViewStyle, tint } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";
import { NativeThemeHost } from "./NativeThemeHost";
import { useControlTheme } from "./useControlTheme";
import { clampProgress, type ProgressProps } from "./Progress.types";

export function Progress(props: ProgressProps) {
  const value = clampProgress(props.value);
  const { colors } = useControlTheme();
  return (
    <View
      className={props.className}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={props.label}
      accessibilityValue={
        value === undefined ? undefined : { min: 0, max: 100, now: Math.round(value * 100) }
      }
      accessibilityState={{ busy: value === undefined }}
    >
      <NativeThemeHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
        <ProgressView
          value={value}
          modifiers={[progressViewStyle("linear"), tint(colors["--color-primary"])]}
        />
      </NativeThemeHost>
    </View>
  );
}
