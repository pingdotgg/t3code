import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  FadeIn,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { cn } from "../../lib/cn";
import { CompactVoiceWaveform, DictationElapsedTime } from "./ComposerDictationControl";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { resolveVoiceComposerPresentation } from "./voiceInputPresentation";

const PILL_HEIGHT = 36;
const COLLAPSED_WIDTH = 64;
const EXPANDED_MAX_WIDTH = 280;
// Clears Home's floating bottom toolbar (56) and a collapsed thread composer (60).
const IOS_BOTTOM_CHROME_CLEARANCE = 64;
const MORPH_TIMING = {
  duration: 260,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);

/**
 * Keeps an off-screen dictation reachable as a pill on the screen's trailing
 * edge. Wraps the app content so any touch that starts outside the pill,
 * including a scroll, collapses it without claiming the touch.
 */
export function GlobalVoiceInputControl(props: { readonly children: ReactNode }) {
  const voice = useGlobalVoiceInput();
  const collapseRef = useRef<(() => void) | null>(null);
  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const visible =
    presentation.statusLabel !== null &&
    !(voice.ownerKey && voice.focusedOwners.has(voice.ownerKey));
  // Mounted only while visible, so each dictation starts collapsed.
  const pill = visible ? <EdgeDictationPill collapseRef={collapseRef} /> : null;
  return (
    <>
      <View
        className="flex-1"
        onStartShouldSetResponderCapture={() => {
          collapseRef.current?.();
          return false;
        }}
      >
        {props.children}
      </View>
      {pill && Platform.OS === "ios" ? <FullWindowOverlay>{pill}</FullWindowOverlay> : pill}
    </>
  );
}

function EdgeDictationPill(props: { readonly collapseRef: RefObject<(() => void) | null> }) {
  const voice = useGlobalVoiceInput();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { fabSize } = useAndroidControlSizing();
  const [expanded, setExpanded] = useState(false);
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, MORPH_TIMING);
  }, [expanded, progress]);
  const { collapseRef } = props;
  useEffect(() => {
    if (!expanded) return;
    collapseRef.current = () => setExpanded(false);
    return () => {
      collapseRef.current = null;
    };
  }, [collapseRef, expanded]);

  const expandedWidth = Math.min(width - insets.left - insets.right - 32, EXPANDED_MAX_WIDTH);
  // Each face keeps its final width and stays pinned to the edge, so the
  // morphing pill reveals the expanded row instead of reflowing it.
  const pillStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [COLLAPSED_WIDTH, expandedWidth]),
  }));
  const collapsedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4], [1, 0], Extrapolation.CLAMP),
  }));
  const expandedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.3, 1], [0, 1], Extrapolation.CLAMP),
  }));

  // Sit just above the bottom chrome: the toolbar or composer on iOS, the
  // new-thread FAB on Android.
  const bottom =
    Platform.OS === "android"
      ? Math.max(insets.bottom, 16) + 16 + fabSize + 12
      : Math.max(insets.bottom, 12) + IOS_BOTTOM_CHROME_CLEARANCE;

  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const phase = voice.state.phase;
  const isError = phase === "error";
  const openSettings = isError && voice.state.errorAction === "settings";
  const label = voice.label ?? "Draft";

  return (
    <View pointerEvents="box-none" className="absolute inset-0">
      <Animated.View
        entering={ENTERING}
        className="absolute rounded-l-full border border-r-0 border-border bg-card shadow-md shadow-black/10"
        style={[{ bottom, right: insets.right, height: PILL_HEIGHT }, pillStyle]}
      >
        <View className="flex-1 overflow-hidden rounded-l-full">
          <Animated.View
            accessibilityElementsHidden={expanded}
            importantForAccessibility={expanded ? "no-hide-descendants" : "auto"}
            pointerEvents={expanded ? "none" : "auto"}
            className="absolute bottom-0 right-0 top-0"
            style={[{ width: COLLAPSED_WIDTH }, collapsedStyle]}
          >
            <Pressable
              accessibilityLabel={`${presentation.statusLabel}, dictating into ${label}`}
              accessibilityHint="Shows dictation controls"
              accessibilityRole="button"
              className="flex-1 flex-row items-center justify-center gap-1.5 active:opacity-70"
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
              ) : phase === "recording" ? (
                <>
                  <View className="size-2 rounded-full bg-danger-foreground" />
                  <DictationElapsedTime
                    className="text-foreground"
                    seconds={voice.elapsedSeconds}
                  />
                </>
              ) : (
                <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
              )}
            </Pressable>
          </Animated.View>

          <Animated.View
            accessibilityElementsHidden={!expanded}
            importantForAccessibility={expanded ? "auto" : "no-hide-descendants"}
            pointerEvents={expanded ? "auto" : "none"}
            className="absolute bottom-0 right-0 top-0 flex-row items-center gap-1.5 pl-1 pr-1.5"
            style={[{ width: expandedWidth }, expandedStyle]}
          >
            <Pressable
              accessibilityLabel={isError ? "Dismiss voice input error" : "Cancel dictation"}
              accessibilityRole="button"
              className="size-[30px] items-center justify-center active:opacity-70"
              onPress={voice.cancel}
            >
              <SymbolView
                name="xmark"
                size={13}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            </Pressable>
            <Pressable
              accessibilityLabel={isError ? (presentation.statusLabel ?? label) : label}
              accessibilityHint="Hides dictation controls"
              accessibilityRole="button"
              className="min-w-0 flex-1 justify-center self-stretch active:opacity-70"
              onPress={() => setExpanded(false)}
            >
              <Text
                className={cn(
                  "text-xs",
                  isError ? "text-danger-foreground" : "font-t3-medium text-foreground",
                )}
                numberOfLines={1}
              >
                {isError ? presentation.statusLabel : label}
              </Text>
            </Pressable>
            {phase === "recording" ? (
              <>
                <CompactVoiceWaveform audioLevels={voice.audioLevels} />
                <DictationElapsedTime
                  className="text-foreground-muted"
                  seconds={voice.elapsedSeconds}
                />
                <Pressable
                  accessibilityLabel="Finish dictation"
                  accessibilityRole="button"
                  className="size-[30px] items-center justify-center active:opacity-70"
                  onPress={voice.stop}
                >
                  <View className="size-[24px] items-center justify-center rounded-full bg-primary">
                    <SymbolView
                      name="checkmark"
                      size={12}
                      weight="semibold"
                      tintColorClassName="accent-primary-foreground"
                      type="monochrome"
                    />
                  </View>
                </Pressable>
              </>
            ) : isError ? (
              voice.isAvailable ? (
                <Pressable
                  accessibilityLabel={openSettings ? "Open microphone settings" : "Retry dictation"}
                  accessibilityRole="button"
                  className="size-[30px] items-center justify-center active:opacity-70"
                  onPress={() => {
                    if (!openSettings) {
                      void voice.session.retry();
                      return;
                    }
                    voice.cancel();
                    void Linking.openSettings();
                  }}
                >
                  <SymbolView name="mic" size={16} tintColorClassName="accent-icon" />
                </Pressable>
              ) : null
            ) : (
              <View
                accessibilityLabel={presentation.statusLabel ?? undefined}
                className="size-[30px] items-center justify-center"
              >
                <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
              </View>
            )}
          </Animated.View>
        </View>
      </Animated.View>
    </View>
  );
}
