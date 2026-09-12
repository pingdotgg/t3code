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
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type EntryExitAnimationFunction,
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
const TOOLBAR_FLIP_TIMING = {
  duration: 260,
  easing: Easing.inOut(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const TOOLBAR_HALF_HEIGHT = 22;
const TOOLBAR_PERSPECTIVE = 600;

/** Moves each face around the same horizontal axis, keeping their edges together. */
function toolbarFlip(fromDegrees: number, toDegrees: number): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const fromRadians = (fromDegrees * Math.PI) / 180;
    const toRadians = (toDegrees * Math.PI) / 180;
    const fromSine = Math.sin(fromRadians);
    const toSine = Math.sin(toRadians);
    return {
      initialValues: {
        opacity: fromDegrees === 0 ? 1 : 0,
        transform: [
          { perspective: TOOLBAR_PERSPECTIVE },
          { translateY: -TOOLBAR_HALF_HEIGHT * fromSine },
          { rotateX: `${fromDegrees}deg` },
        ],
      },
      animations: {
        opacity: withTiming(toDegrees === 0 ? 1 : 0, TOOLBAR_FLIP_TIMING),
        transform: [
          { perspective: TOOLBAR_PERSPECTIVE },
          {
            translateY: withTiming(-TOOLBAR_HALF_HEIGHT * toSine, {
              ...TOOLBAR_FLIP_TIMING,
              easing: (time) => {
                const angle =
                  fromRadians + (toRadians - fromRadians) * TOOLBAR_FLIP_TIMING.easing(time);
                return (Math.sin(angle) - fromSine) / (toSine - fromSine);
              },
            }),
          },
          { rotateX: withTiming(`${toDegrees}deg`, TOOLBAR_FLIP_TIMING) },
        ],
      },
    };
  };
}

const DRAFT_TOOLBAR_ENTERING = toolbarFlip(90, 0);
const DRAFT_TOOLBAR_EXITING = toolbarFlip(0, 90);
const DICTATION_TOOLBAR_ENTERING = toolbarFlip(-90, 0);
const DICTATION_TOOLBAR_EXITING = toolbarFlip(0, -90);
const WAVEFORM_BAR_HEIGHT = 32;
const WAVEFORM_MIN_BAR_HEIGHT = 2;
const WAVEFORM_BAR_SPACING = 5;
const WAVEFORM_TIMING = {
  duration: 100,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
} as const;

/** Rotates the compact draft away without unmounting or resizing its native editor. */
export function ComposerDictationDraftContent(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly compact: boolean;
  readonly hidden: boolean;
}) {
  const rotation = useSharedValue(props.hidden ? 1 : 0);
  useLayoutEffect(() => {
    rotation.value = withTiming(props.hidden ? 1 : 0, TOOLBAR_FLIP_TIMING);
  }, [props.hidden, rotation]);
  const compact = props.compact;
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: compact ? 1 - rotation.value : 1,
    transform: compact
      ? [
          { perspective: TOOLBAR_PERSPECTIVE },
          { translateY: -TOOLBAR_HALF_HEIGHT * Math.sin((rotation.value * Math.PI) / 2) },
          { rotateX: `${rotation.value * 90}deg` },
        ]
      : [],
  }));

  return (
    <Animated.View
      accessibilityElementsHidden={props.hidden}
      importantForAccessibility={props.hidden ? "no-hide-descendants" : "auto"}
      collapsable={false}
      className={props.className}
      layout={DICTATION_LAYOUT}
      pointerEvents={props.hidden ? "none" : "auto"}
      style={[animatedStyle, { backfaceVisibility: "hidden" }]}
    >
      {props.children}
    </Animated.View>
  );
}

/** Flips the entire row while keeping the outgoing controls intact until it leaves. */
export function ComposerDictationToolbar(props: {
  readonly children: ReactNode;
  readonly showsDictation: boolean;
  readonly visible?: boolean;
}) {
  return (
    <View className="relative h-[44px] overflow-hidden">
      {props.visible !== false ? (
        <Animated.View
          key={props.showsDictation ? "dictation" : "draft"}
          className="absolute inset-0"
          entering={props.showsDictation ? DICTATION_TOOLBAR_ENTERING : DRAFT_TOOLBAR_ENTERING}
          exiting={props.showsDictation ? DICTATION_TOOLBAR_EXITING : DRAFT_TOOLBAR_EXITING}
          style={{ backfaceVisibility: "hidden" }}
        >
          {props.children}
        </Animated.View>
      ) : null}
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
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled && !props.loading ? 0.4 : 1 }}
    >
      <View
        className={cn(
          "items-center justify-center",
          variant === "primary" ? "size-[30px] rounded-full bg-subtle" : "size-[44px]",
        )}
      >
        {variant === "primary" ? (
          <Animated.View
            className="absolute inset-0 rounded-full bg-primary"
            style={primaryStyle}
          />
        ) : null}
        <View className="absolute inset-0 items-center justify-center">
          {props.loading ? (
            <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
          ) : (
            <SymbolView
              name={props.icon}
              size={variant === "primary" ? 16 : 20}
              weight={variant === "primary" ? "semibold" : "regular"}
              tintColorClassName={
                variant === "primary" ? "accent-primary-foreground" : "accent-icon"
              }
              type="monochrome"
            />
          )}
        </View>
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
  }));
  const labelStyle = useAnimatedStyle(() => ({
    opacity: 1 - recordingVisibility.value,
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

  return <ComposerDictationStartAction {...props} />;
}

export function ComposerDictationStartAction(props: {
  readonly state: VoiceInputState;
  readonly isAvailable: boolean;
  readonly disabled?: boolean;
  readonly onStart: () => void;
  readonly onCancel: () => void;
}) {
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
