import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsStepperRow(props: {
  readonly icon: SymbolName;
  readonly label: string;
  readonly value: number;
  readonly displayValue?: string;
  readonly valueLabel: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onValueChange: (value: number) => void;
}) {
  const icon = useThemeColor("--color-icon");
  const control = useThemeColor("--color-icon-muted");
  const border = useThemeColor("--color-secondary-border");
  const step = props.step ?? 1;
  const decrementDisabled = props.value <= props.min;
  const incrementDisabled = props.value >= props.max;

  return (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView name={props.icon} size={22} tintColor={icon} type="monochrome" weight="regular" />
      <View className="min-w-0 flex-1">
        <Text className="text-lg text-foreground">{props.label}</Text>
        <Text className="text-sm text-foreground-muted">{props.valueLabel}</Text>
      </View>
      <View className="flex-row items-center">
        <Pressable
          accessibilityLabel={`Decrease ${props.label}`}
          accessibilityRole="button"
          disabled={decrementDisabled}
          hitSlop={8}
          onPress={() => props.onValueChange(Math.max(props.min, props.value - step))}
          className={decrementDisabled ? "opacity-[0.35]" : undefined}
        >
          <View
            className="size-10 items-center justify-center rounded-full border"
            style={{ borderColor: border }}
          >
            <SymbolView
              name="minus"
              size={18}
              tintColor={control}
              type="monochrome"
              weight="semibold"
            />
          </View>
        </Pressable>
        <Text
          accessibilityLabel={props.valueLabel}
          className="w-12 text-center text-lg font-t3-medium text-foreground"
        >
          {props.displayValue ?? props.value}
        </Text>
        <Pressable
          accessibilityLabel={`Increase ${props.label}`}
          accessibilityRole="button"
          disabled={incrementDisabled}
          hitSlop={8}
          onPress={() => props.onValueChange(Math.min(props.max, props.value + step))}
          className={incrementDisabled ? "opacity-[0.35]" : undefined}
        >
          <View
            className="size-10 items-center justify-center rounded-full border"
            style={{ borderColor: border }}
          >
            <SymbolView
              name="plus"
              size={18}
              tintColor={control}
              type="monochrome"
              weight="semibold"
            />
          </View>
        </Pressable>
      </View>
    </View>
  );
}
