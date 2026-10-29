import { GlassView } from "expo-glass-effect";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, withTiming } from "react-native-reanimated";
import { withUniwind } from "uniwind";

import { cn } from "../../lib/cn";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { AppText } from "./AppText";

const TabGlass = withUniwind(GlassView, { style: { fromClassName: "className" } });

export interface TabsProps<Value extends string> {
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    /** Rendered after the label, such as diff stats or a count. */
    readonly trailing?: ReactNode;
  }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  readonly className?: string;
}

/** Section navigation. Value pickers use SegmentedControl. */
export function Tabs<Value extends string>(props: TabsProps<Value>) {
  const { themeAppearance } = useAppearancePreferences();
  const reduceMotion = useReducedMotion();
  const [frames, setFrames] = useState<Partial<Record<Value, { x: number; width: number }>>>({});
  const frame = frames[props.selected];
  const duration = reduceMotion ? 0 : 220;
  const indicatorStyle = useAnimatedStyle(() => ({
    width: withTiming(frame?.width ?? 0, { duration }),
    transform: [{ translateX: withTiming(frame?.x ?? 0, { duration }) }],
  }));

  return (
    <View accessibilityRole="tablist" className={cn("flex-row", props.className)}>
      {frame ? (
        <Animated.View
          pointerEvents="none"
          className="absolute bottom-0 left-0 top-0 rounded-full border border-border-subtle"
          style={indicatorStyle}
        >
          {NATIVE_LIQUID_GLASS_SUPPORTED ? (
            <TabGlass
              className="flex-1 rounded-full"
              colorScheme={themeAppearance === "dark" ? "dark" : "light"}
            />
          ) : (
            <View className="flex-1 rounded-full bg-grouped-card" />
          )}
        </Animated.View>
      ) : null}
      {props.options.map((option) => {
        const selected = option.value === props.selected;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => props.onSelect(option.value)}
            onLayout={({ nativeEvent: { layout } }) =>
              setFrames((current) =>
                current[option.value]?.x === layout.x &&
                current[option.value]?.width === layout.width
                  ? current
                  : { ...current, [option.value]: { x: layout.x, width: layout.width } },
              )
            }
            className="min-h-9 flex-row items-center gap-1.5 rounded-full px-3.5 active:opacity-70"
          >
            <AppText
              textRole="footnote"
              className={cn(
                "font-t3-semibold",
                selected ? "text-foreground" : "text-foreground-muted",
              )}
            >
              {option.label}
            </AppText>
            {option.trailing}
          </Pressable>
        );
      })}
    </View>
  );
}
