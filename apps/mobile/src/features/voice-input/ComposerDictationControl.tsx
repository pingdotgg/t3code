import type { VoiceInputPhase, VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { memo, useCallback, useLayoutEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import type { VoiceComposerPresentation } from "./voiceInputPresentation";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const DICTATION_TIMING = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const DICTATION_LAYOUT =
  Platform.OS === "android"
    ? undefined
    : LinearTransition.duration(DICTATION_TIMING.duration).reduceMotion(ReduceMotion.System);
const DICTATION_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const DICTATION_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
const WAVEFORM_BAR_HEIGHT = 32;
const WAVEFORM_MIN_BAR_HEIGHT = 2;
const WAVEFORM_BAR_SPACING = 5;
const WAVEFORM_TIMING = {
  duration: 100,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
} as const;

/** Keeps the native editor mounted when compact dictation replaces the draft area. */
export function ComposerDictationDraftContent(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly collapsed: boolean;
}) {
  const visibility = useSharedValue(props.collapsed ? 0 : 1);
  useLayoutEffect(() => {
    visibility.value = withTiming(props.collapsed ? 0 : 1, DICTATION_TIMING);
  }, [props.collapsed, visibility]);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: visibility.value,
    transform: [{ translateY: -4 * (1 - visibility.value) }],
  }));

  return (
    <Animated.View
      accessibilityElementsHidden={props.collapsed}
      importantForAccessibility={props.collapsed ? "no-hide-descendants" : "auto"}
      collapsable={false}
      className={props.className}
      layout={DICTATION_LAYOUT}
      style={[animatedStyle, { overflow: "hidden" }, props.collapsed ? { height: 0 } : undefined]}
    >
      {props.children}
    </Animated.View>
  );
}

/** Crossfades controls within one toolbar row while the draft keeps its position. */
export function ComposerDictationToolbar(props: {
  readonly children: ReactNode;
  readonly showsDictation: boolean;
  readonly visible?: boolean;
}) {
  return (
    <View className="relative h-11">
      <Animated.View
        key={props.showsDictation ? "dictation" : "draft"}
        className="absolute inset-0"
        entering={DICTATION_ENTERING}
        exiting={props.visible === false ? undefined : DICTATION_EXITING}
      >
        {props.children}
      </Animated.View>
    </View>
  );
}

const WaveformBar = memo(function WaveformBar(props: {
  readonly audioLevels: SharedValue<number[]>;
  readonly sampleIndex: number;
}) {
  const { audioLevels, sampleIndex } = props;
  const animatedStyle = useAnimatedStyle(() => {
    const level = audioLevels.value[sampleIndex] ?? 0;
    return {
      opacity: withTiming(0.22 + level * 0.78, WAVEFORM_TIMING),
      transform: [
        {
          scaleY: withTiming(
            (WAVEFORM_MIN_BAR_HEIGHT + level * (WAVEFORM_BAR_HEIGHT - WAVEFORM_MIN_BAR_HEIGHT)) /
              WAVEFORM_BAR_HEIGHT,
            WAVEFORM_TIMING,
          ),
        },
      ],
    };
  });

  return (
    <Animated.View
      className="w-0.5 rounded-full bg-foreground"
      style={[{ height: WAVEFORM_BAR_HEIGHT }, animatedStyle]}
    />
  );
});

const VoiceWaveform = memo(function VoiceWaveform(props: {
  readonly audioLevels: SharedValue<number[]>;
}) {
  const [barCount, setBarCount] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setBarCount(
      Math.max(
        1,
        Math.min(
          VOICE_WAVEFORM_SAMPLE_COUNT,
          Math.floor(event.nativeEvent.layout.width / WAVEFORM_BAR_SPACING),
        ),
      ),
    );
  }, []);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="min-w-0 flex-1 flex-row items-center justify-between overflow-hidden"
      style={{ height: WAVEFORM_BAR_HEIGHT }}
      onLayout={handleLayout}
    >
      {Array.from({ length: barCount }, (_, index) => (
        <WaveformBar
          key={index}
          audioLevels={props.audioLevels}
          sampleIndex={VOICE_WAVEFORM_SAMPLE_COUNT - barCount + index}
        />
      ))}
    </View>
  );
});

function VoiceActionButton(props: {
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: AppSymbolName;
  readonly loading?: boolean;
  readonly onPress: () => void;
  readonly variant?: "plain" | "primary";
}) {
  const variant = props.variant ?? "plain";
  const loadingVisibility = useSharedValue(props.loading ? 1 : 0);
  useLayoutEffect(() => {
    loadingVisibility.value = withTiming(props.loading ? 1 : 0, DICTATION_TIMING);
  }, [loadingVisibility, props.loading]);
  const primaryStyle = useAnimatedStyle(() => ({ opacity: 1 - loadingVisibility.value }));

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: props.loading, disabled: props.disabled }}
      className={cn(
        "items-center justify-center active:opacity-70",
        variant === "primary" ? "size-11" : "size-9",
      )}
      disabled={props.disabled}
      hitSlop={variant === "plain" ? 4 : undefined}
      onPress={props.onPress}
      style={{ opacity: props.disabled && !props.loading ? 0.4 : 1 }}
    >
      <View
        className={cn(
          "items-center justify-center",
          variant === "primary" ? "size-11 rounded-full bg-subtle" : "size-9",
        )}
      >
        {variant === "primary" ? (
          <Animated.View
            className="absolute inset-0 rounded-full bg-primary"
            style={primaryStyle}
          />
        ) : null}
        <Animated.View
          key={props.loading ? "loading" : "icon"}
          className="absolute inset-0 items-center justify-center"
          entering={DICTATION_ENTERING}
          exiting={DICTATION_EXITING}
        >
          {props.loading ? (
            <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
          ) : (
            <SymbolView
              name={props.icon}
              size={17}
              tintColorClassName={
                variant === "primary" ? "accent-primary-foreground" : "accent-icon"
              }
              type="monochrome"
            />
          )}
        </Animated.View>
      </View>
    </Pressable>
  );
}

export function ComposerDictationStatus(props: {
  readonly audioLevels: SharedValue<number[]>;
  readonly elapsedSeconds: number;
  readonly phase: VoiceInputPhase;
  readonly presentation: VoiceComposerPresentation;
  readonly onDismissError: () => void;
}) {
  const recordingVisibility = useSharedValue(props.phase === "recording" ? 1 : 0);
  useLayoutEffect(() => {
    recordingVisibility.value = withTiming(props.phase === "recording" ? 1 : 0, DICTATION_TIMING);
  }, [props.phase, recordingVisibility]);
  const waveformStyle = useAnimatedStyle(() => ({
    opacity: recordingVisibility.value,
    transform: [{ translateY: -4 * (1 - recordingVisibility.value) }],
  }));
  const labelStyle = useAnimatedStyle(() => ({
    opacity: 1 - recordingVisibility.value,
    transform: [{ translateY: 4 * recordingVisibility.value }],
  }));

  if (!props.presentation.statusLabel) return null;
  const isError = props.presentation.statusKind === "error";
  const elapsedLabel = `${Math.floor(props.elapsedSeconds / 60)}:${String(props.elapsedSeconds % 60).padStart(2, "0")}`;
  return (
    <View className="relative h-11 min-w-0 flex-1 justify-center">
      {isError ? (
        <View className="min-w-0 flex-row items-center gap-1.5 px-2">
          <Text className="min-w-0 flex-1 text-sm text-red-400" numberOfLines={2}>
            {props.presentation.statusLabel}
          </Text>
          <Pressable
            accessibilityLabel="Dismiss voice input error"
            accessibilityRole="button"
            className="size-7 items-center justify-center active:opacity-70"
            hitSlop={8}
            onPress={props.onDismissError}
          >
            <SymbolView
              name="xmark"
              size={12}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
      ) : (
        <View
          accessible
          accessibilityLabel={props.presentation.statusLabel}
          accessibilityLiveRegion={props.phase === "recording" ? "none" : "polite"}
          className="h-11"
        >
          <Animated.View
            className="absolute inset-0 min-w-0 flex-row items-center gap-2 px-1"
            style={waveformStyle}
          >
            <VoiceWaveform audioLevels={props.audioLevels} />
            <Text
              className="text-xs text-foreground-muted"
              numberOfLines={1}
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {elapsedLabel}
            </Text>
          </Animated.View>
          <Animated.View className="absolute inset-0 justify-center px-2" style={labelStyle}>
            <Text className="text-center text-sm text-foreground-muted" numberOfLines={1}>
              {props.presentation.statusLabel}
            </Text>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

export function ComposerDictationCancelAction(props: {
  readonly presentation: VoiceComposerPresentation;
  readonly onCancel: () => void;
}) {
  if (props.presentation.leadingAction !== "cancel") return null;
  return (
    <VoiceActionButton
      accessibilityLabel="Cancel dictation"
      icon="xmark"
      onPress={props.onCancel}
    />
  );
}

export function ComposerDictationPrimaryAction(props: {
  readonly state: VoiceInputState;
  readonly presentation: VoiceComposerPresentation;
  readonly isAvailable: boolean;
  readonly disabled?: boolean;
  readonly onStart: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  if (props.presentation.trailingAction === "confirm") {
    return (
      <VoiceActionButton
        accessibilityLabel={
          props.presentation.confirmationEnabled
            ? "Finish dictation"
            : (props.presentation.statusLabel ?? "Preparing voice input")
        }
        disabled={!props.presentation.confirmationEnabled}
        icon="checkmark"
        loading={!props.presentation.confirmationEnabled}
        onPress={props.onConfirm}
        variant="primary"
      />
    );
  }

  if (!props.isAvailable) return null;
  const openSettings = props.state.phase === "error" && props.state.errorAction === "settings";
  return (
    <VoiceActionButton
      accessibilityLabel={openSettings ? "Open microphone settings" : "Start dictation"}
      disabled={props.disabled}
      icon="mic"
      onPress={
        openSettings
          ? () => {
              props.onCancel();
              void Linking.openSettings();
            }
          : props.onStart
      }
    />
  );
}
