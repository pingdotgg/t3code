import type { VoiceModePhase } from "@t3tools/client-runtime/voice-mode";
import { memo, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useVoiceModeState } from "./useVoiceMode";
import { voiceMode } from "./voiceMode";
import {
  createSpeakingDetector,
  resolveVoiceStripStatus,
  VOICE_STRIP_STATUS_LABEL,
  voiceCaptionTail,
  voiceMeterLevel,
} from "./voiceModePresentation";

const LEVEL_TIMING = { duration: 100, reduceMotion: ReduceMotion.System } as const;
const METER_HEIGHT = 16;
const VISIBLE_CAPTIONS = 2;

/** Starts or ends a voice conversation on the thread. Lit while one is live there. */
export function ComposerVoiceModeButton(props: {
  readonly phase: VoiceModePhase;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const live = props.phase !== "idle";
  return (
    <Pressable
      accessibilityLabel={live ? "End voice conversation" : "Start voice conversation"}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, selected: live }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.4 : 1 }}
    >
      <View
        className={cn(
          "size-[30px] items-center justify-center rounded-full",
          live ? "bg-primary" : undefined,
        )}
      >
        <SymbolView
          name="waveform"
          size={live ? 16 : 20}
          tintColorClassName={live ? "accent-primary-foreground" : "accent-icon"}
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}

const LevelBar = memo(function LevelBar(props: {
  readonly level: SharedValue<number>;
  readonly className: string;
}) {
  const { level } = props;
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: 0.15 + level.value * 0.85 }],
  }));
  return (
    <Animated.View
      className={cn("w-1 rounded-full", props.className)}
      style={[{ height: METER_HEIGHT }, animatedStyle]}
    />
  );
});

function StripButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      className="size-9 items-center justify-center rounded-full active:bg-subtle"
      hitSlop={4}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={16} tintColorClassName="accent-icon" type="monochrome" />
    </Pressable>
  );
}

/**
 * The live conversation's status, levels, controls, and newest captions.
 * Render only while this thread's conversation is connecting or active.
 */
export function ComposerVoiceStrip() {
  const state = useVoiceModeState();
  const microphoneLevel = useSharedValue(0);
  const speakerLevel = useSharedValue(0);
  const [speaking, setSpeaking] = useState(false);

  // Levels arrive at 10Hz; they drive shared values directly, and the
  // speaking flag only re-renders when it flips.
  useEffect(() => {
    const isSpeaking = createSpeakingDetector();
    const unsubscribe = voiceMode.subscribeLevels((levels) => {
      microphoneLevel.value = withTiming(voiceMeterLevel(levels.microphone), LEVEL_TIMING);
      speakerLevel.value = withTiming(voiceMeterLevel(levels.speaker), LEVEL_TIMING);
      setSpeaking(isSpeaking(levels.speaker, Date.now()));
    });
    return () => {
      unsubscribe();
    };
  }, [microphoneLevel, speakerLevel]);

  const status = resolveVoiceStripStatus({ phase: state.phase, muted: state.muted, speaking });
  const captions = state.captions.slice(-VISIBLE_CAPTIONS);

  return (
    <View className="mb-2 gap-1 rounded-2xl border border-composer-border bg-card px-3 py-1.5">
      <View className="flex-row items-center gap-2">
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="flex-row items-center gap-0.5"
          style={{ height: METER_HEIGHT }}
        >
          <LevelBar level={microphoneLevel} className="bg-foreground" />
          <LevelBar level={speakerLevel} className="bg-primary" />
        </View>
        <Text
          accessibilityLiveRegion="polite"
          className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
          numberOfLines={1}
        >
          {VOICE_STRIP_STATUS_LABEL[status]}
        </Text>
        <StripButton
          accessibilityLabel={state.muted ? "Unmute microphone" : "Mute microphone"}
          icon={state.muted ? "mic.slash" : "mic"}
          onPress={() => voiceMode.toggleMuted()}
        />
        <StripButton
          accessibilityLabel="End voice conversation"
          icon="stop.fill"
          onPress={() => voiceMode.stop()}
        />
      </View>
      {captions.map((caption, index) => (
        <Text
          // Captions have no identity; the open one keeps its slot while it streams.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className={cn(
            "text-sm",
            caption.role === "user" ? "italic text-foreground-muted" : "text-foreground",
          )}
          numberOfLines={2}
        >
          {voiceCaptionTail(caption.text)}
        </Text>
      ))}
    </View>
  );
}
