import {
  isLiquidGlassSupported,
  LiquidGlassContainerView,
  LiquidGlassView,
} from "@callstack/liquid-glass";
import { useEffect, useState } from "react";
import { Text as SystemText, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { withUniwind } from "uniwind";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";

const CONTROL_HEIGHT = 44;
const CONTROL_COMPOSER_GAP = 8;
const GLASS_MERGE_SPACING = 12;
const CONTROL_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const CONTROL_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
const CONTROL_TIMING = {
  duration: 240,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const CONTROL_SEPARATION = (16 + CONTROL_HEIGHT) / 2;

const UniwindLiquidGlassView = withUniwind(LiquidGlassView);
const UniwindLiquidGlassContainerView = withUniwind(LiquidGlassContainerView);
const AnimatedLiquidGlassView = Animated.createAnimatedComponent(UniwindLiquidGlassView);

export const FLOATING_WORKING_CONTROL_COVERAGE = CONTROL_HEIGHT + CONTROL_COMPOSER_GAP;

export function FloatingWorkingControl(props: {
  readonly colorScheme: "light" | "dark";
  readonly startedAt: string | null;
  readonly showScrollToEnd: boolean;
  readonly onScrollToEnd: () => void;
}) {
  const separationProgress = useSharedValue(props.showScrollToEnd ? 1 : 0);

  useEffect(() => {
    separationProgress.value = withTiming(props.showScrollToEnd ? 1 : 0, CONTROL_TIMING);
  }, [props.showScrollToEnd, separationProgress]);

  const timerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: CONTROL_SEPARATION * (1 - separationProgress.value) }],
  }));
  const arrowTransformStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -CONTROL_SEPARATION * (1 - separationProgress.value) }],
  }));
  const arrowContentStyle = useAnimatedStyle(() => ({
    opacity: separationProgress.value,
  }));

  if (props.startedAt === null && !props.showScrollToEnd) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="box-none"
      className="absolute left-0 right-0 z-20 items-center"
      style={{ top: -FLOATING_WORKING_CONTROL_COVERAGE }}
      entering={isLiquidGlassSupported ? undefined : CONTROL_ENTERING}
      exiting={isLiquidGlassSupported ? undefined : CONTROL_EXITING}
    >
      {props.startedAt !== null && isLiquidGlassSupported ? (
        <UniwindLiquidGlassContainerView
          spacing={GLASS_MERGE_SPACING}
          pointerEvents="box-none"
          className="flex-row items-center gap-4"
        >
          <AnimatedLiquidGlassView
            colorScheme={props.colorScheme}
            effect="regular"
            pointerEvents="none"
            className="h-11 justify-center overflow-hidden rounded-full"
            style={timerStyle}
          >
            <WorkingDuration startedAt={props.startedAt} />
          </AnimatedLiquidGlassView>

          <AnimatedLiquidGlassView
            colorScheme={props.colorScheme}
            effect="regular"
            interactive
            pointerEvents={props.showScrollToEnd ? "auto" : "none"}
            accessibilityElementsHidden={!props.showScrollToEnd}
            importantForAccessibility={props.showScrollToEnd ? "auto" : "no-hide-descendants"}
            className="h-11 w-11 items-center justify-center overflow-hidden rounded-full"
            style={arrowTransformStyle}
          >
            <Animated.View style={arrowContentStyle}>
              <ScrollToEndButton disabled={!props.showScrollToEnd} onPress={props.onScrollToEnd} />
            </Animated.View>
          </AnimatedLiquidGlassView>
        </UniwindLiquidGlassContainerView>
      ) : props.startedAt !== null ? (
        <View pointerEvents="box-none" className="flex-row items-center gap-4">
          <Animated.View
            pointerEvents="none"
            className="h-11 justify-center rounded-full border border-border bg-card shadow-md shadow-black/10"
            style={timerStyle}
          >
            <WorkingDuration startedAt={props.startedAt} />
          </Animated.View>

          <Animated.View
            pointerEvents={props.showScrollToEnd ? "auto" : "none"}
            accessibilityElementsHidden={!props.showScrollToEnd}
            importantForAccessibility={props.showScrollToEnd ? "auto" : "no-hide-descendants"}
            style={[arrowTransformStyle, arrowContentStyle]}
          >
            <ControlPill
              accessibilityLabel="Scroll to end"
              activateOnPressIn
              className="h-11 w-11 border border-border bg-card shadow-md shadow-black/10"
              disabled={!props.showScrollToEnd}
              icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
              onPress={props.onScrollToEnd}
            />
          </Animated.View>
        </View>
      ) : isLiquidGlassSupported ? (
        <UniwindLiquidGlassView
          colorScheme={props.colorScheme}
          effect="regular"
          interactive
          className="h-11 w-11 items-center justify-center overflow-hidden rounded-full"
        >
          <ScrollToEndButton onPress={props.onScrollToEnd} />
        </UniwindLiquidGlassView>
      ) : (
        <ControlPill
          accessibilityLabel="Scroll to end"
          activateOnPressIn
          className="h-11 w-11 border border-border bg-card shadow-md shadow-black/10"
          icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
          onPress={props.onScrollToEnd}
        />
      )}
    </Animated.View>
  );
}

function WorkingDuration(props: { readonly startedAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [props.startedAt]);

  const duration = formatWorkingDuration(props.startedAt, nowMs);
  const label = `Working for ${duration}`;

  return (
    <View accessible accessibilityLabel={label} className="h-11 flex-row items-center px-4">
      <Text className="font-t3-medium text-xs text-foreground">Working for </Text>
      <SystemText
        className="text-xs text-foreground"
        style={{ fontVariant: ["tabular-nums"], fontWeight: "500" }}
      >
        {duration}
      </SystemText>
    </View>
  );
}

function formatWorkingDuration(startedAt: string, nowMs: number): string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || nowMs <= startedAtMs) {
    return "0s";
  }

  const totalSeconds = Math.floor((nowMs - startedAtMs) / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}m ${seconds}s`;
}

function ScrollToEndButton(props: { readonly disabled?: boolean; readonly onPress: () => void }) {
  return (
    <ControlPill
      accessibilityLabel="Scroll to end"
      activateOnPressIn
      className="h-11 w-11 bg-transparent"
      disabled={props.disabled}
      icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
      onPress={props.onPress}
    />
  );
}
