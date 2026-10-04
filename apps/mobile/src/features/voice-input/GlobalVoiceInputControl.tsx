import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import {
  ComposerDictationCancelAction,
  ComposerDictationPrimaryAction,
  ComposerDictationStatus,
} from "./ComposerDictationControl";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { resolveVoiceComposerPresentation } from "./voiceInputPresentation";

const EXPANDED_MAX_WIDTH = 360;
const ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

/** Keeps an off-screen dictation reachable as a pill on the screen's trailing edge. */
export function GlobalVoiceInputControl() {
  const voice = useGlobalVoiceInput();
  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  if (!presentation.statusLabel || (voice.ownerKey && voice.focusedOwners.has(voice.ownerKey))) {
    return null;
  }
  // Mounted only while visible, so each dictation starts collapsed.
  const content = <EdgeDictationPill />;
  return Platform.OS === "ios" ? <FullWindowOverlay>{content}</FullWindowOverlay> : content;
}

function EdgeDictationPill() {
  const voice = useGlobalVoiceInput();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const label = voice.label ?? "Draft";
  const isError = presentation.statusKind === "error";
  const elapsedLabel = `${Math.floor(voice.elapsedSeconds / 60)}:${String(voice.elapsedSeconds % 60).padStart(2, "0")}`;

  return (
    <View pointerEvents="box-none" className="absolute inset-0">
      <View
        pointerEvents="box-none"
        className="absolute items-end"
        style={{ top: Math.round(height * 0.4), right: insets.right }}
      >
        {expanded ? (
          <Animated.View
            key="expanded"
            entering={ENTERING}
            exiting={EXITING}
            className="rounded-l-2xl border border-r-0 border-border bg-card pb-1 pl-2 pt-2.5 shadow-md shadow-black/10"
            style={{ width: Math.min(width - insets.left - insets.right - 24, EXPANDED_MAX_WIDTH) }}
          >
            <View className="flex-row items-center gap-2 pl-2">
              <View className="min-w-0 flex-1">
                <Text className="text-xs text-foreground-muted">Dictating into</Text>
                <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
                  {label}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Hide dictation controls"
                accessibilityRole="button"
                className="size-9 items-center justify-center active:opacity-70"
                onPress={() => setExpanded(false)}
              >
                <SymbolView
                  name="chevron.right"
                  size={14}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
              </Pressable>
            </View>
            <View className="flex-row items-center pr-1">
              <ComposerDictationCancelAction presentation={presentation} onCancel={voice.cancel} />
              <ComposerDictationStatus
                audioLevels={voice.audioLevels}
                elapsedSeconds={voice.elapsedSeconds}
                phase={voice.state.phase}
                presentation={presentation}
                onDismissError={voice.cancel}
              />
              <ComposerDictationPrimaryAction
                state={voice.state}
                presentation={presentation}
                isAvailable={voice.isAvailable}
                onStart={() => void voice.session.retry()}
                onConfirm={voice.stop}
                onCancel={voice.cancel}
              />
            </View>
          </Animated.View>
        ) : (
          <Animated.View key="collapsed" entering={ENTERING} exiting={EXITING}>
            <Pressable
              accessibilityLabel={`${presentation.statusLabel}, dictating into ${label}`}
              accessibilityHint="Shows dictation controls"
              accessibilityRole="button"
              className="h-9 flex-row items-center gap-1.5 rounded-l-full border border-r-0 border-border bg-card pl-3 pr-2.5 shadow-md shadow-black/10 active:opacity-70"
              hitSlop={{ top: 6, bottom: 6, left: 6 }}
              onPress={() => setExpanded(true)}
            >
              {isError ? (
                <SymbolView
                  name="exclamationmark.circle"
                  size={16}
                  tintColorClassName="accent-danger-foreground"
                  type="monochrome"
                />
              ) : voice.state.phase === "recording" ? (
                <>
                  <View className="size-2 rounded-full bg-danger-foreground" />
                  <Text
                    className="text-xs text-foreground"
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {elapsedLabel}
                  </Text>
                </>
              ) : (
                <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
              )}
            </Pressable>
          </Animated.View>
        )}
      </View>
    </View>
  );
}
