import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { GlassContainer, GlassView } from "expo-glass-effect";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text as SystemText, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
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

const CONTROL_HEIGHT = 38.5; // h-11 with the mobile 14px rem
// The collapsed composer capsule starts 6 below its overlay's top edge, so
// the pill sits at (gap - 6) above the overlay to leave the same gap to the
// capsule as the feed's end inset leaves between it and the last row.
const CONTROL_GAP = 8;
const COMPOSER_CAPSULE_INSET = 6;
const GLASS_MERGE_SPACING = 12;
const CONTROL_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const CONTROL_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
const CONTROL_TIMING = {
  duration: 240,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const CONTROL_SEPARATION = (16 + CONTROL_HEIGHT) / 2;
// The label swaps between syncing, compacting, and working while the capsule
// stays mounted, so the capsule animates to the new label's width and the
// labels cross-fade instead of the pill snapping between sizes.
const CAPSULE_LAYOUT = LinearTransition.duration(CONTROL_TIMING.duration)
  .easing(CONTROL_TIMING.easing)
  .reduceMotion(ReduceMotion.System);
const LABEL_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const LABEL_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

// Expo reapplies glass after native layout and window reattachment, when UIKit
// can otherwise leave the label visible but lose the material behind it.
const UniwindGlassView = withUniwind(GlassView, {
  style: { fromClassName: "className" },
});
const UniwindGlassContainer = withUniwind(GlassContainer, {
  style: { fromClassName: "className" },
});
const AnimatedGlassView = Animated.createAnimatedComponent(UniwindGlassView);

const CONTROL_OVERLAY_OFFSET = CONTROL_HEIGHT + CONTROL_GAP - COMPOSER_CAPSULE_INSET;
export const FLOATING_WORKING_CONTROL_COVERAGE = CONTROL_OVERLAY_OFFSET + CONTROL_GAP;

/**
 * What the floating pill says. Connection, syncing, and working share one
 * element so the label swaps in place instead of one pill fading out for
 * another. The connection variant is tappable and triggers a reconnect.
 */
export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  | {
      readonly kind: "connection";
      readonly tone: "reconnecting" | "unavailable";
      readonly label: string;
      readonly onPress: () => void;
    };

export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "connection",
        tone: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
        onPress: input.onReconnect,
      };
    case "offline":
      return unavailable("You are offline");
    case "error":
      return unavailable(
        input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      );
    case "available":
      return unavailable(`${environmentLabel} is not connected`);
    case "connected":
      return null;
  }
}

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

  // Only the connection label is a button (tap to reconnect); the others
  // pass touches through to the feed like before.
  const statusInteractive = props.status?.kind === "connection";

  return (
    <Animated.View
      pointerEvents="box-none"
      className="absolute left-0 right-0 z-20 items-center"
      style={{ top: -CONTROL_OVERLAY_OFFSET }}
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
            isInteractive={statusInteractive}
            pointerEvents={statusInteractive ? "auto" : "none"}
            className="h-11 justify-center overflow-hidden rounded-full"
            style={timerStyle}
            layout={CAPSULE_LAYOUT}
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
            pointerEvents={statusInteractive ? "auto" : "none"}
            className="h-11 justify-center rounded-full border border-border bg-card shadow-md shadow-black/10"
            style={timerStyle}
            layout={CAPSULE_LAYOUT}
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
    <StatusLabelRow accessibilityLabel="Compacting" className="gap-1.5">
      <SymbolView
        name="arrow.down.right.and.arrow.up.left"
        size={13}
        tintColorClassName="foreground"
        type="monochrome"
      />
      <Text className="font-t3-medium text-xs text-foreground">Compacting…</Text>
    </StatusLabelRow>
  );
}

function FloatingStatusLabel(props: { readonly status: FloatingWorkingStatus }) {
  // Keyed by kind so a swap mounts a fresh row and the two cross-fade while
  // the capsule's layout transition carries the width change.
  if (props.status.kind === "syncing") {
    return (
      <StatusLabelRow key="syncing" accessibilityLabel={props.status.label} className="gap-2">
        <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        <Text className="font-t3-medium text-xs text-foreground">{props.status.label}</Text>
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "compacting") {
    return <CompactingLabel key="compacting" />;
  }
  if (props.status.kind === "connection") {
    return (
      <StatusLabelRow
        key="connection"
        accessibilityLabel={props.status.label}
        accessibilityRole="button"
        className="gap-2"
        onPress={props.status.onPress}
      >
        {props.status.tone === "reconnecting" ? (
          <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : (
          <View className="h-2 w-2 rounded-full bg-red-500" />
        )}
        <Text className="max-w-[260px] font-t3-medium text-xs text-foreground" numberOfLines={1}>
          {props.status.label}
        </Text>
      </StatusLabelRow>
    );
  }
  return <WorkingDuration key="working" startedAt={props.status.startedAt} />;
}

function StatusLabelRow(props: {
  readonly accessibilityLabel: string;
  readonly accessibilityRole?: "button";
  readonly className?: string;
  readonly children: ReactNode;
  readonly onPress?: () => void;
}) {
  const rowClassName = `h-11 flex-row items-center px-4 ${props.className ?? ""}`;
  return (
    <Animated.View entering={LABEL_ENTERING} exiting={LABEL_EXITING}>
      {props.onPress ? (
        <Pressable
          accessibilityLabel={props.accessibilityLabel}
          accessibilityRole={props.accessibilityRole}
          className={`${rowClassName} active:opacity-70`}
          onPress={props.onPress}
        >
          {props.children}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={props.accessibilityLabel} className={rowClassName}>
          {props.children}
        </View>
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
    <StatusLabelRow accessibilityLabel={label}>
      <Text className="font-t3-medium text-xs text-foreground">Working for </Text>
      <SystemText
        className="text-xs text-foreground"
        style={{ fontVariant: ["tabular-nums"], fontWeight: "500" }}
      >
        {duration}
      </SystemText>
    </StatusLabelRow>
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
  if (totalSeconds >= 3_600) {
    return formatDuration(totalSeconds * 1_000);
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
