import { Slider } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  accessibilityValue,
  disabled,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import * as Haptics from "expo-haptics";
import { useRef } from "react";
import { View } from "react-native";

import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { NativeThemeHost } from "./NativeThemeHost";
import type { SliderRowProps } from "./SliderRow.types";
import { useControlTheme } from "./useControlTheme";

export type { SliderRowProps } from "./SliderRow.types";

export function SliderRow(props: SliderRowProps) {
  const { colors } = useControlTheme();
  // The value of the drag in progress; null until the drag moves.
  const draft = useRef<number | null>(null);
  const editing = useRef(false);
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
    <View className={props.disabled ? "gap-1 p-4 opacity-[0.45]" : "gap-1 p-4"}>
      <View className="flex-row items-center gap-4">
        <SymbolView name={props.icon} size={22} tintColorClassName="accent-icon" />
        <AppText className="flex-1 text-lg text-foreground">{props.label}</AppText>
        <AppText className="text-base font-t3-medium text-foreground-muted">
          {props.valueLabel}
        </AppText>
      </View>
      <View className="flex-row items-center gap-3">
        {props.minimumIcon ? (
          <SymbolView name={props.minimumIcon} size={15} tintColorClassName="accent-icon-muted" />
        ) : null}
        <NativeThemeHost style={{ flex: 1, height: 44 }}>
          <Slider
            min={props.min}
            max={props.max}
            step={props.step}
            value={props.value}
            modifiers={[
              tint(colors["--color-primary"]),
              disabled(Boolean(props.disabled)),
              accessibilityLabel(props.label),
              accessibilityValue(props.valueLabel),
            ]}
            onValueChange={(value) => {
              // Accessibility adjustments do not begin a touch editing session.
              if (editing.current) draft.current = value;
              else commit(value);
            }}
            onEditingChanged={(isEditing) => {
              editing.current = isEditing;
              const value = draft.current;
              draft.current = null;
              if (!isEditing && value !== null) commit(value);
            }}
          />
        </NativeThemeHost>
        {props.maximumIcon ? (
          <SymbolView name={props.maximumIcon} size={22} tintColorClassName="accent-icon-muted" />
        ) : null}
      </View>
    </View>
  );
}
