import { useState } from "react";
import { I18nManager, Platform, Pressable, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import Animated, { useAnimatedStyle, useReducedMotion, withTiming } from "react-native-reanimated";

import { AppText } from "./AppText";
import { useControlTheme } from "./useControlTheme";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

/** Shared capsule control with native press targets and a raised selection. */
export function SegmentedControl<Value extends string | number>(
  props: SegmentedControlProps<Value>,
) {
  const { colorScheme, colors } = useControlTheme();
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const { width, height } = layout;
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
          boxShadow: dark ? "0px 1px 2px #00000062" : "0px 1px 2px #00000014",
        }}
      >
        <CapsuleSurface
          width={width}
          height={height}
          dark={dark}
          fillTop={colors[dark ? "--color-screen" : "--color-grouped-card"]}
          fillBottom={colors["--color-card"]}
          edgeColor={colors["--color-foreground"]}
        />
        {selectedIndex >= 0 && width > 0 ? (
          <Animated.View
            pointerEvents="none"
            className="absolute bottom-[3px] start-[3px] top-[3px] rounded-full"
            style={[
              {
                boxShadow: dark ? "0px 1px 2px #00000046" : "0px 2px 3px #00000026",
              },
              selectionStyle,
            ]}
          >
            <CapsuleSurface
              width={segmentWidth}
              height={height - 6}
              dark={dark}
              fillTop={colors[dark ? "--color-secondary" : "--color-screen"]}
              fillBottom={colors[dark ? "--color-secondary" : "--color-screen"]}
              edgeColor={colors["--color-secondary-foreground"]}
              selected
            />
          </Animated.View>
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

/** Pen's inset well and raised selection use opposite vertical edge lighting. */
function CapsuleSurface({
  width,
  height,
  dark,
  fillTop,
  fillBottom,
  edgeColor,
  selected = false,
}: {
  width: number;
  height: number;
  dark: boolean;
  fillTop: string;
  fillBottom: string;
  edgeColor: string;
  selected?: boolean;
}) {
  if (width <= 0 || height <= 0) return null;
  const edgeOpacity = selected
    ? dark
      ? [0.22, 0.02]
      : [0.13, 0.01]
    : dark
      ? [0.02, 0.16]
      : [0.27, 0.1];
  return (
    <Svg
      pointerEvents="none"
      width={width}
      height={height}
      style={{ position: "absolute", top: 0, left: 0 }}
    >
      <Defs>
        <LinearGradient id="fill" x1="0" y1="0" x2="0%" y2="100%">
          <Stop offset="0" stopColor={fillTop} />
          <Stop offset="1" stopColor={fillBottom} />
        </LinearGradient>
        <LinearGradient id="edge" x1="0" y1="0" x2="0%" y2="100%">
          <Stop offset="0" stopColor={edgeColor} stopOpacity={edgeOpacity[0]} />
          <Stop offset="1" stopColor={edgeColor} stopOpacity={edgeOpacity[1]} />
        </LinearGradient>
      </Defs>
      <Rect
        x={0.5}
        y={0.5}
        width={width - 1}
        height={height - 1}
        rx={(height - 1) / 2}
        fill="url(#fill)"
      />
      {selected && !dark ? (
        <Rect width={width} height={height} rx={height / 2} fill="white" fillOpacity={0.85} />
      ) : null}
      <Rect
        x={0.5}
        y={0.5}
        width={width - 1}
        height={height - 1}
        rx={(height - 1) / 2}
        fill="none"
        stroke="url(#edge)"
        strokeWidth={1}
      />
    </Svg>
  );
}
