import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { RETURN_PULSE_FALL_MS, RETURN_PULSE_RISE_MS } from "../home/return-pulse";

/** Peak strength of the wash over the row's own background. */
const PEAK_OPACITY = 0.85;

/**
 * Washes the row's background brighter/darker once. Mount it with a new `key`
 * to pulse again. With Reduce Motion on it holds the highlight still instead.
 */
export function ReturnPulseOverlay(props: {
  readonly color: string;
  readonly borderRadius?: number;
}) {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the one-shot pulse animation when the overlay mounts
  useEffect(() => {
    // Reanimated would otherwise skip the timings entirely under Reduce Motion.
    const never = ReduceMotion.Never;
    opacity.set(
      reducedMotion
        ? withSequence(
            withTiming(PEAK_OPACITY, { duration: 0, reduceMotion: never }),
            withDelay(
              RETURN_PULSE_RISE_MS + RETURN_PULSE_FALL_MS,
              withTiming(0, { duration: 150, reduceMotion: never }),
              never,
            ),
          )
        : withSequence(
            withTiming(PEAK_OPACITY, {
              duration: RETURN_PULSE_RISE_MS,
              easing: Easing.inOut(Easing.sin),
              reduceMotion: never,
            }),
            withTiming(0, {
              duration: RETURN_PULSE_FALL_MS,
              easing: Easing.inOut(Easing.sin),
              reduceMotion: never,
            }),
          ),
    );
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one pulse per mount; a new pulse remounts with a new key
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: props.color, borderRadius: props.borderRadius ?? 0 },
        style,
      ]}
    />
  );
}
