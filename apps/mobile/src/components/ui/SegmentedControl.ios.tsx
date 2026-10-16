import { requireNativeView } from "expo";
import { View, type NativeSyntheticEvent, type ViewProps } from "react-native";

import {
  flattenThemeColor,
  themeColorWithAlpha,
  themeColorWithContrast,
} from "../../lib/mobileTheme";
import { useControlTheme } from "./useControlTheme";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

const NativeSegmentedControl = requireNativeView<
  ViewProps & {
    labels: string[];
    selectedIndex: number;
    trackColor: string;
    selectedColor: string;
    textColor: string;
    mutedColor: string;
    appearance: string;
    onSelectionChange: (event: NativeSyntheticEvent<{ index: number }>) => void;
  }
>("T3NativeControls", "SegmentedControl");

export function SegmentedControl<Value extends string | number>(
  props: SegmentedControlProps<Value>,
) {
  const { colors, colorScheme } = useControlTheme();
  const trackColor = flattenThemeColor(
    themeColorWithAlpha(colors["--color-primary"], colorScheme === "dark" ? 0.18 : 0.07),
    colors["--color-screen"],
  );
  const selectedColor =
    colorScheme === "dark" ? colors["--color-primary"] : colors["--color-secondary"];
  const selectedTextColor =
    colorScheme === "dark"
      ? colors["--color-primary-foreground"]
      : colors["--color-secondary-foreground"];
  return (
    <View className={props.className}>
      <NativeSegmentedControl
        labels={props.options.map((option) => option.label)}
        selectedIndex={props.options.findIndex((option) => option.value === props.selected)}
        trackColor={trackColor}
        selectedColor={selectedColor}
        textColor={selectedTextColor}
        mutedColor={themeColorWithContrast(
          colors["--color-foreground-muted"],
          trackColor,
          colorScheme === "dark" ? 7 : 4.5,
        )}
        appearance={colorScheme}
        onSelectionChange={({ nativeEvent }) => {
          const option = props.options[nativeEvent.index];
          if (option) props.onSelect(option.value);
        }}
        style={{ height: props.size === "compact" ? 32 : 36 }}
      />
    </View>
  );
}
