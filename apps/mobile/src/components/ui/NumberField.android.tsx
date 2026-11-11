import { View } from "react-native";

import { AppText } from "./AppText";
import { IconButton } from "./IconButton";
import type { NumberFieldProps } from "./NumberField.types";

export function NumberField(props: NumberFieldProps) {
  const adjust = (amount: number) => {
    if (props.disabled) return;
    const next = Math.max(props.min, Math.min(props.max, props.value + amount));
    if (next !== props.value) props.onValueChange(next);
  };

  return (
    <View className="shrink-0 flex-row items-center">
      <View
        pointerEvents="none"
        className="absolute inset-x-0 rounded-full bg-subtle"
        style={{ height: 32 }}
      />
      <IconButton
        icon="minus"
        accessibilityLabel={`Decrease ${props.label}`}
        disabled={props.disabled || props.value <= props.min}
        onPress={() => adjust(-1)}
      />
      <AppText
        textRole="body"
        className="min-w-8 text-center"
        style={{ fontVariant: ["tabular-nums"] }}
        accessibilityLabel={`${props.label}: ${props.formatValue?.(props.value) ?? props.value}`}
        accessibilityLiveRegion="polite"
      >
        {props.value}
      </AppText>
      <IconButton
        icon="plus"
        accessibilityLabel={`Increase ${props.label}`}
        disabled={props.disabled || props.value >= props.max}
        onPress={() => adjust(1)}
      />
    </View>
  );
}
