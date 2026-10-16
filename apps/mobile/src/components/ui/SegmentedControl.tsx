import { useState } from "react";
import { I18nManager, Platform, Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, withTiming } from "react-native-reanimated";

import { AppText } from "./AppText";
import { useControlTheme } from "./useControlTheme";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

/** Shared capsule control with native press targets and a flat, themed selection. */
export function SegmentedControl<Value extends string | number>(
  props: SegmentedControlProps<Value>,
) {
  const { colorScheme, colors } = useControlTheme();
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const { width } = layout;
  const reduceMotion = useReducedMotion();
  const selectedIndex = props.options.findIndex((option) => option.value === props.selected);
  const segmentWidth = props.options.length ? Math.max(0, width - 6) / props.options.length : 0;
  const selectionOffset = selectedIndex * segmentWidth * (I18nManager.isRTL ? -1 : 1);
  const selectionStyle = useAnimatedStyle(() => ({
    width: segmentWidth,
    transform: [{ translateX: withTiming(selectionOffset, { duration: reduceMotion ? 0 : 160 }) }],
  }));
  const dark = colorScheme === "dark";
  const minHeight = props.size === "compact" ? 32 : Platform.OS === "android" ? 40 : 36;

  return (
    <View collapsable={false} className={props.className}>
      <View
        onLayout={(event) => setLayout(event.nativeEvent.layout)}
        className="flex-row rounded-full p-[3px]"
        style={{
          minHeight,
          backgroundColor: colors[dark ? "--color-screen" : "--color-grouped-card"],
        }}
      >
        {selectedIndex >= 0 && width > 0 ? (
          <Animated.View
            pointerEvents="none"
            className="absolute bottom-[3px] start-[3px] top-[3px] rounded-full"
            style={[
              {
                backgroundColor: colors[dark ? "--color-secondary" : "--color-screen"],
              },
              selectionStyle,
            ]}
          />
        ) : null}
        {props.options.map((option) => {
          const selected = option.value === props.selected;
          return (
            <Pressable
              key={`${typeof option.value}:${option.value}`}
              accessibilityRole={props.role ?? "button"}
              accessibilityLabel={option.accessibilityLabel ?? option.label}
              accessibilityState={{ selected }}
              onPress={() => props.onSelect(option.value)}
              className="flex-1 items-center justify-center rounded-full px-2 py-1 active:opacity-70"
              style={{ minHeight: minHeight - 6 }}
            >
              <AppText
                textRole="footnote"
                className={selected ? "font-t3-bold" : "font-t3-medium"}
                style={{
                  color:
                    colors[selected ? "--color-secondary-foreground" : "--color-foreground-muted"],
                }}
              >
                {option.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
