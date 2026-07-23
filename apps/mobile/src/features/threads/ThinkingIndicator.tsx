import { memo, useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";

const DOT_COLORS = ["#78b88a", "#91c9a3", "#b0a8c4"] as const;

function ThinkingDot(props: { readonly color: string; readonly delayMs: number }) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? 0.85 : 0.35);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 0.85;
      return;
    }
    progress.value = withDelay(
      props.delayMs,
      withRepeat(
        withSequence(
          withTiming(1, {
            duration: 420,
            easing: Easing.inOut(Easing.ease),
            reduceMotion: ReduceMotion.System,
          }),
          withTiming(0.35, {
            duration: 420,
            easing: Easing.inOut(Easing.ease),
            reduceMotion: ReduceMotion.System,
          }),
        ),
        -1,
        false,
      ),
    );
    return () => {
      cancelAnimation(progress);
    };
  }, [progress, props.delayMs, reduceMotion]);

  const style = useAnimatedStyle(() => {
    if (reduceMotion) {
      return { opacity: progress.value };
    }
    return {
      opacity: progress.value,
      transform: [{ scale: 0.85 + progress.value * 0.3 }],
    };
  });

  return (
    <Animated.View
      style={[
        {
          height: 6,
          width: 6,
          borderRadius: 999,
          backgroundColor: props.color,
        },
        style,
      ]}
    />
  );
}

/**
 * Parent-agent silent-reasoning cue. Soft pastel dots + "Thinking…" — not a
 * spinner, and not the subagent "Working..." treatment.
 */
export const ThinkingIndicator = memo(function ThinkingIndicator() {
  return (
    <View className="px-4 pb-2" style={{ flexShrink: 0 }} accessibilityLabel="Thinking">
      <View
        className="self-start rounded-full border border-accent/20 bg-accent-soft px-3 py-2"
        style={{ borderCurve: "continuous" }}
      >
        <View className="flex-row items-center gap-2">
          <View className="flex-row items-center gap-1">
            {DOT_COLORS.map((color, index) => (
              <ThinkingDot key={color} color={color} delayMs={index * 140} />
            ))}
          </View>
          <Text className="font-t3-medium text-xs italic text-accent">Thinking…</Text>
        </View>
      </View>
    </View>
  );
});
