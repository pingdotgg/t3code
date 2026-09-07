import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { GlassContainer, GlassView } from "expo-glass-effect";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  Text as SystemText,
  View,
} from "react-native";
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
import type { FloatingWorkingStatus } from "./floating-working-status";
import { ShimmeringWorkContent } from "./thread-work-log";

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
// Both rows share the same centered anchor, so the outgoing one clears fast and
// the incoming one waits for it to be mostly gone before it starts to show.
const LABEL_ENTERING = FadeIn.duration(160).delay(80).reduceMotion(ReduceMotion.System);
const LABEL_EXITING = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

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

  const arrowTransformStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -CONTROL_SEPARATION * (1 - separationProgress.value) }],
  }));
  const arrowContentStyle = useAnimatedStyle(() => ({
    opacity: separationProgress.value,
  }));

  // The label swaps between connection, syncing, compacting, and working while
  // the capsule stays mounted. A layout transition on the capsule would move
  // its left edge, and labels laid out from that edge slide with it, so the pill
  // reads as shifting sideways. Instead an in-flow sizer animates to the
  // measured label width and the capsule takes its size from that, while the
  // labels sit centered on top. The row re-centers as the capsule grows, so its
  // midpoint never moves and the text underneath stays put.
  //
  // The sizer has to carry the width rather than the capsule itself: the native
  // glass view only picks up a size from a real layout pass, so an animated
  // width set straight on it leaves the glass stuck at its mounted size.
  const capsuleWidth = useSharedValue<number | null>(null);
  const measuredWidthRef = useRef<number | null>(null);
  const handleLabelLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width === measuredWidthRef.current) {
      return;
    }
    const first = measuredWidthRef.current === null;
    measuredWidthRef.current = width;
    capsuleWidth.value = first ? width : withTiming(width, CONTROL_TIMING);
  };
  // Forget the width while no label is shown so the next one appears at its
  // own size instead of animating from the previous label's.
  const hasStatus = props.status !== null;
  useEffect(() => {
    if (!hasStatus) {
      measuredWidthRef.current = null;
      capsuleWidth.value = null;
    }
  }, [capsuleWidth, hasStatus]);
  const capsuleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: CONTROL_SEPARATION * (1 - separationProgress.value) }],
  }));
  // Zero until the first measurement lands, so the capsule never paints around
  // a label it has not sized to yet.
  const capsuleSizerStyle = useAnimatedStyle(() => ({ width: capsuleWidth.value ?? 0 }));

  if (props.status === null && !props.showScrollToEnd) {
    return null;
  }

  // Only the connection label is a button (tap to reconnect); the others
  // pass touches through to the feed like before.
  const statusInteractive = props.status?.kind === "connection";
  // Yoga centers an absolute child that has no insets on its parent's align and
  // justify, so each label row lands centered on the capsule without measuring
  // itself, and the capsule clips whatever a wider label overhangs while it
  // catches up.
  const statusContent =
    props.status !== null ? (
      <>
        <Animated.View className="h-11" style={capsuleSizerStyle} />
        <FloatingStatusLabel status={props.status} onLayout={handleLabelLayout} />
      </>
    ) : null;

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
            pointerEvents={statusInteractive ? "box-none" : "none"}
            className="h-11 items-center justify-center overflow-hidden rounded-full"
            style={capsuleStyle}
          >
            {statusContent}
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
            pointerEvents={statusInteractive ? "box-none" : "none"}
            className="h-11 items-center justify-center overflow-hidden rounded-full border border-border bg-card shadow-md shadow-black/10"
            style={capsuleStyle}
          >
            {statusContent}
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

function CompactingLabel(props: { readonly onLayout: (event: LayoutChangeEvent) => void }) {
  return (
    <StatusLabelRow accessibilityLabel="Compacting" className="gap-1.5" onLayout={props.onLayout}>
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

function FloatingStatusLabel(props: {
  readonly status: FloatingWorkingStatus;
  readonly onLayout: (event: LayoutChangeEvent) => void;
}) {
  // Keyed by kind so a swap mounts a fresh row and the two cross-fade while
  // the capsule animates to the new row's measured width.
  if (props.status.kind === "syncing") {
    return (
      <StatusLabelRow
        key="syncing"
        accessibilityLabel={props.status.label}
        className="gap-2"
        onLayout={props.onLayout}
      >
        <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        <Text className="font-t3-medium text-xs text-foreground">{props.status.label}</Text>
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "compacting") {
    return <CompactingLabel key="compacting" onLayout={props.onLayout} />;
  }
  if (props.status.kind === "connection") {
    return (
      <StatusLabelRow
        key="connection"
        accessibilityLabel={props.status.label}
        accessibilityRole="button"
        className="gap-2"
        onLayout={props.onLayout}
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
  if (props.status.kind === "preparing") {
    return (
      <StatusLabelRow
        key="preparing"
        accessibilityLabel={props.status.label}
        className="gap-1.5"
        onLayout={props.onLayout}
      >
        <SymbolView
          name="arrow.triangle.branch"
          size={13}
          tintColorClassName="foreground"
          type="monochrome"
        />
        <ShimmeringWorkContent
          className="flex-none"
          textClassName="font-t3-medium"
          compact
          icon="arrow.triangle.branch"
          iconSubtleColor="transparent"
          label={props.status.label}
          showIcon={false}
        />
      </StatusLabelRow>
    );
  }
  return (
    <WorkingDuration key="working" startedAt={props.status.startedAt} onLayout={props.onLayout} />
  );
}

// Rows are absolute with no insets, so the capsule centers them on itself and an
// exiting row fading out never shifts the incoming one.
function StatusLabelRow(props: {
  readonly accessibilityLabel: string;
  readonly accessibilityRole?: "button";
  readonly className?: string;
  readonly children: ReactNode;
  readonly onLayout: (event: LayoutChangeEvent) => void;
  readonly onPress?: () => void;
}) {
  const rowClassName = `h-11 flex-row items-center px-4 ${props.className ?? ""}`;
  return (
    <Animated.View
      className="absolute"
      entering={LABEL_ENTERING}
      exiting={LABEL_EXITING}
      onLayout={props.onLayout}
    >
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

function WorkingDuration(props: {
  readonly startedAt: string;
  readonly onLayout: (event: LayoutChangeEvent) => void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [props.startedAt]);

  const duration = formatWorkingDuration(props.startedAt, nowMs);
  const label = `Working for ${duration}`;

  return (
    <StatusLabelRow accessibilityLabel={label} onLayout={props.onLayout}>
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
