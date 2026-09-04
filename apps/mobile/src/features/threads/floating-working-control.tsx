import { GlassContainer, GlassView } from "expo-glass-effect";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text as SystemText, View } from "react-native";
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
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";

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

// Expo reapplies glass after native layout and window reattachment, when UIKit
// can otherwise leave the label visible but lose the material behind it.
const UniwindGlassView = withUniwind(GlassView, {
  style: { fromClassName: "className" },
});
const UniwindGlassContainer = withUniwind(GlassContainer, {
  style: { fromClassName: "className" },
});
const AnimatedGlassView = Animated.createAnimatedComponent(UniwindGlassView);

export const FLOATING_WORKING_CONTROL_COVERAGE = CONTROL_HEIGHT + CONTROL_COMPOSER_GAP;

/**
 * What the floating pill says. Syncing and working share one element so the
 * label swaps in place instead of one pill fading out for another.
 */
export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" };

export function FloatingWorkingControl(props: {
  readonly colorScheme: "light" | "dark";
  readonly status: FloatingWorkingStatus | null;
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

  if (props.status === null && !props.showScrollToEnd) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="box-none"
      className="absolute left-0 right-0 z-20 items-center"
      style={{ top: -FLOATING_WORKING_CONTROL_COVERAGE }}
      entering={NATIVE_LIQUID_GLASS_SUPPORTED ? undefined : CONTROL_ENTERING}
      exiting={NATIVE_LIQUID_GLASS_SUPPORTED ? undefined : CONTROL_EXITING}
    >
      {props.status !== null && NATIVE_LIQUID_GLASS_SUPPORTED ? (
        <UniwindGlassContainer
          spacing={GLASS_MERGE_SPACING}
          pointerEvents="box-none"
          className="flex-row items-center gap-4"
        >
          <AnimatedGlassView
            colorScheme={props.colorScheme}
            glassEffectStyle="regular"
            pointerEvents="none"
            className="h-11 justify-center overflow-hidden rounded-full"
            style={timerStyle}
          >
            <FloatingStatusLabel status={props.status} />
          </AnimatedGlassView>

          <AnimatedGlassView
            colorScheme={props.colorScheme}
            glassEffectStyle="regular"
            isInteractive
            pointerEvents={props.showScrollToEnd ? "auto" : "none"}
            accessibilityElementsHidden={!props.showScrollToEnd}
            importantForAccessibility={props.showScrollToEnd ? "auto" : "no-hide-descendants"}
            className="h-11 w-11 items-center justify-center overflow-hidden rounded-full"
            style={arrowTransformStyle}
          >
            <Animated.View style={arrowContentStyle}>
              <ScrollToEndButton disabled={!props.showScrollToEnd} onPress={props.onScrollToEnd} />
            </Animated.View>
          </AnimatedGlassView>
        </UniwindGlassContainer>
      ) : props.status !== null ? (
        <View pointerEvents="box-none" className="flex-row items-center gap-4">
          <Animated.View
            pointerEvents="none"
            className="h-11 justify-center rounded-full border border-border bg-card shadow-md shadow-black/10"
            style={timerStyle}
          >
            <FloatingStatusLabel status={props.status} />
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
      ) : NATIVE_LIQUID_GLASS_SUPPORTED ? (
        <UniwindGlassView
          colorScheme={props.colorScheme}
          glassEffectStyle="regular"
          isInteractive
          className="h-11 w-11 items-center justify-center overflow-hidden rounded-full"
        >
          <ScrollToEndButton onPress={props.onScrollToEnd} />
        </UniwindGlassView>
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

function CompactingLabel() {
  return (
    <View
      accessible
      accessibilityLabel="Compacting"
      className="h-11 flex-row items-center gap-1.5 px-4"
    >
      <SymbolView
        name="arrow.down.right.and.arrow.up.left"
        size={13}
        tintColorClassName="foreground"
        type="monochrome"
      />
      <Text className="font-t3-medium text-xs text-foreground">Compacting…</Text>
    </View>
  );
}

function FloatingStatusLabel(props: { readonly status: FloatingWorkingStatus }) {
  if (props.status.kind === "syncing") {
    return (
      <View
        accessible
        accessibilityLabel={props.status.label}
        className="h-11 flex-row items-center gap-2 px-4"
      >
        <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        <Text className="font-t3-medium text-xs text-foreground">{props.status.label}</Text>
      </View>
    );
  }
  if (props.status.kind === "compacting") {
    return <CompactingLabel />;
  }
  return <WorkingDuration startedAt={props.status.startedAt} />;
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
