import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  type LayoutAnimation,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

const ROLL_TIMING = {
  duration: 400,
  easing: Easing.bezier(0.3, 0.8, 0.2, 1),
  reduceMotion: ReduceMotion.System,
} as const;

function rollIn(values: EntryAnimationsValues): LayoutAnimation {
  "worklet";
  return {
    initialValues: { transform: [{ translateY: values.targetHeight }] },
    animations: { transform: [{ translateY: withTiming(0, ROLL_TIMING) }] },
  };
}

function rollOut(values: ExitAnimationsValues): LayoutAnimation {
  "worklet";
  return {
    initialValues: { transform: [{ translateY: 0 }] },
    animations: { transform: [{ translateY: withTiming(-values.currentHeight, ROLL_TIMING) }] },
  };
}

function SlotDot(props: { readonly delay: number; readonly className: string }) {
  const opacity = useSharedValue(0.3);
  useEffect(() => {
    opacity.value = withDelay(
      props.delay,
      withRepeat(
        withTiming(1, {
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        true,
      ),
    );
    return () => cancelAnimation(opacity);
  }, [opacity, props.delay]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={style}>
      <Text className={cn("text-base", props.className)}>•</Text>
    </Animated.View>
  );
}

export function ThreadTitleSlotRoll(props: {
  readonly regenerating: boolean;
  readonly dotClassName: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="overflow-hidden">
      <LayoutAnimationConfig skipEntering>
        {props.regenerating ? (
          <Animated.View key="dots" entering={rollIn} exiting={rollOut}>
            <View className="flex-row items-center gap-1">
              <SlotDot delay={0} className={props.dotClassName} />
              <SlotDot delay={150} className={props.dotClassName} />
              <SlotDot delay={300} className={props.dotClassName} />
            </View>
          </Animated.View>
        ) : (
          <Animated.View key="title" entering={rollIn} exiting={rollOut}>
            {props.children}
          </Animated.View>
        )}
      </LayoutAnimationConfig>
    </View>
  );
}
