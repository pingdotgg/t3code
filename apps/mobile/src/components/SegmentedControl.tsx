import { Platform, Pressable, View } from "react-native";
import Animated, { Easing, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { AppText as Text } from "./AppText";
import { cn } from "../lib/cn";

export function SegmentedControl<Value extends number | string>(props: {
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly accessibilityLabel?: string;
  }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  /** The tab bar is full height; filters under it are shorter so it stays primary. */
  readonly size?: "default" | "compact";
  /** "tab" for the view switcher; filters stay plain buttons. */
  readonly role?: "tab" | "button";
  readonly className?: string;
}) {
  const compact = props.size === "compact";
  return (
    <View
      accessible={false}
      className={cn(
        "flex-row overflow-hidden rounded-full border-continuous bg-card",
        props.className,
      )}
    >
      <Animated.View
        pointerEvents="none"
        layout={LinearTransition.duration(200)
          .easing(Easing.out(Easing.cubic))
          .reduceMotion(ReduceMotion.System)}
        className="absolute bottom-0 top-0 rounded-full bg-subtle-strong"
        style={{
          width: `${100 / props.options.length}%`,
          start: `${
            (Math.max(
              0,
              props.options.findIndex((option) => option.value === props.selected),
            ) *
              100) /
            props.options.length
          }%`,
        }}
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
                active ? "font-t3-medium text-foreground" : "text-foreground-muted",
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
