import { requireNativeView } from "expo";
import { View, type NativeSyntheticEvent, type ViewProps } from "react-native";

import { SegmentedControl as FlatSegmentedControl } from "./SegmentedControl.shared";
import { segmentedControlColors } from "./segmentedControlColors";
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
  const { colors, colorScheme, themeId } = useControlTheme();
  // UIKit adds a gray fill over the sunken card track.
  if (props.variant === "card") return <FlatSegmentedControl {...props} />;
  const { trackColor, selectedColor, selectedTextColor, mutedColor } = segmentedControlColors(
    colors,
    colorScheme,
    props.variant,
    "ios",
    themeId,
  );
  return (
    <View className={props.className}>
      <NativeSegmentedControl
        labels={props.options.map((option) => option.label)}
        selectedIndex={props.options.findIndex((option) => option.value === props.selected)}
        trackColor={trackColor}
        selectedColor={selectedColor}
        textColor={selectedTextColor}
        mutedColor={mutedColor}
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
