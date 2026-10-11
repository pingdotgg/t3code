import { useEffect, useState } from "react";
import { I18nManager, Platform, Pressable, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AppText as Text } from "./AppText";
import { cn } from "../lib/cn";
import { MaterialSegmentedControl } from "./MaterialSegmentedControl";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

export function SegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const compact = props.size === "compact";
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.selected),
  );
  const position = useSharedValue(index);
  useEffect(() => {
    position.set(
      withTiming(index, {
        duration: 200,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [index, position]);
  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          ((position.value * width) / props.options.length) * (I18nManager.isRTL ? -1 : 1),
      },
    ],
  }));
  if (Platform.OS === "android") {
    return <MaterialSegmentedControl {...props} />;
  }
  return (
    <View
      accessible={false}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      className={cn(
        "flex-row overflow-hidden",
        "rounded-full border-continuous bg-card",
        props.className,
      )}
    >
      <Animated.View
        pointerEvents="none"
        className="absolute inset-y-0 rounded-full bg-secondary"
        style={[{ width: `${100 / props.options.length}%`, start: 0 }, indicatorStyle]}
      />
      {props.options.map((option) => {
        const active = option.value === props.selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole={Platform.OS === "ios" ? "button" : (props.role ?? "button")}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected: active }}
            onPress={() => props.onSelect(option.value)}
            className={cn(
              "flex-1 items-center justify-center rounded-full",
              compact ? "h-9" : "h-11",
            )}
          >
            <Text
              className={cn(
                compact ? "text-xs" : "text-sm",
                active ? "font-t3-medium text-secondary-foreground" : "text-foreground-muted",
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
