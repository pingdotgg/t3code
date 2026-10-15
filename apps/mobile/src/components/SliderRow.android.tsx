import { Host, Slider } from "@expo/ui/jetpack-compose";
import { fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import * as Haptics from "expo-haptics";
import { useRef, type ComponentProps } from "react";
import { View } from "react-native";

import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { useControlTheme } from "./useControlTheme";
import type { SliderRow as SharedSliderRow } from "./SliderRow";

export function SliderRow(props: ComponentProps<typeof SharedSliderRow>) {
  const { colorScheme, systemColorsActive, colors } = useControlTheme();
  const draft = useRef(props.value);
  const commit = (value: number) => {
    if (props.disabled) return;
    const next = Math.min(
      props.max,
      Math.max(props.min, props.min + Math.round((value - props.min) / props.step) * props.step),
    );
    if (next === props.value) return;
    void Haptics.selectionAsync().catch(() => undefined);
    props.onChange(next);
  };
  return (
    <View className={props.disabled ? "gap-2 p-4 opacity-45" : "gap-2 p-4"}>
      <View className="flex-row items-center gap-4">
        <SymbolView name={props.icon} size={24} tintColorClassName="accent-icon" />
        <Text className="min-w-0 flex-1 text-base">{props.label}</Text>
        <Text className="text-sm text-foreground-muted">{props.valueLabel}</Text>
      </View>
      <View
        accessible
        accessibilityLabel={props.label}
        accessibilityRole="adjustable"
        accessibilityState={{ disabled: Boolean(props.disabled) }}
        accessibilityValue={{
          min: props.min,
          max: props.max,
          now: props.value,
          text: props.valueLabel,
        }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "increment") commit(props.value + props.step);
          else if (nativeEvent.actionName === "decrement") commit(props.value - props.step);
        }}
      >
        <View importantForAccessibility="no-hide-descendants">
          <Host
            colorScheme={colorScheme}
            seedColor={systemColorsActive ? undefined : colors["--color-primary"]}
            style={{ height: 48, width: "100%" }}
          >
            <Slider
              min={props.min}
              max={props.max}
              value={props.value}
              steps={Math.max(0, Math.round((props.max - props.min) / props.step) - 1)}
              enabled={!props.disabled}
              modifiers={[fillMaxWidth()]}
              colors={{
                thumbColor: colors["--color-primary"],
                activeTrackColor: colors["--color-primary"],
                inactiveTrackColor: colors["--color-secondary"],
              }}
              onValueChange={(value) => {
                draft.current = value;
              }}
              onValueChangeFinished={() => commit(draft.current)}
            />
          </Host>
        </View>
      </View>
    </View>
  );
}
