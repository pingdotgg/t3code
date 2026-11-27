import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_READ_ALOUD_SETTINGS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useEffect, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOut, useSharedValue } from "react-native-reanimated";

import { ComposerSurface } from "../../components/ComposerSurface";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { VoiceWaveform } from "../voice-input/ComposerDictationControl";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "../voice-input/voiceInputMetering";
import { alertReadAloudError } from "./ReadAloudButton";
import { readAloudController } from "./playback";
import { getReadAloudAway, scrollToReadAloud, subscribeReadAloudAway } from "./readAloudFollow";

/** The settings schema caps read-aloud speed at 1.5. */
const SPEEDS = [0.75, 1, 1.25, 1.5] as const;
const SILENT_LEVELS: ReadonlyArray<number> = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
const BAR_SHAPE = { borderRadius: 22, borderCurve: "circular", overflow: "hidden" } as const;

/**
 * Controls for the reply read aloud in this thread, above its composer while it is read: its
 * loudness, speed, pause and stop, and a way back to the word read once it is scrolled away.
 */
export function ReadAloudBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  const id = state.id;
  if (
    !id?.startsWith(`${props.environmentId}:${props.threadId}:`) ||
    (state.status !== "loading" && state.status !== "playing" && state.status !== "paused")
  )
    return null;
  return (
    <Animated.View
      className="shrink-0 px-3 pb-2"
      entering={FadeInDown.duration(180)}
      exiting={FadeOut.duration(120)}
    >
      <ReadAloudBarControls id={id} status={state.status} />
    </Animated.View>
  );
}

function ReadAloudBarControls(props: {
  readonly id: string;
  readonly status: "loading" | "playing" | "paused";
}) {
  const { id, status } = props;
  const gt = useGT();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const settings = AsyncResult.isSuccess(preferences)
    ? (preferences.value.readAloud ?? DEFAULT_READ_ALOUD_SETTINGS)
    : DEFAULT_READ_ALOUD_SETTINGS;
  const away = useSyncExternalStore(subscribeReadAloudAway, getReadAloudAway);
  const levels = useSharedValue(SILENT_LEVELS);
  const silent = useSharedValue(SILENT_LEVELS);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds the playback's loudness to the waveform's shared value, which moves the bars without re-rendering
  useEffect(() => {
    let history = SILENT_LEVELS;
    return readAloudController.subscribeLevel((level) => {
      history = [...history.slice(1), level];
      levels.set(history);
    });
  }, [levels]);

  const reportError = () => alertReadAloudError(id, gt("Could not read aloud"));
  const changeSpeed = (speed: number) => {
    if (speed === settings.speed) return;
    void savePreferences({ readAloud: { ...settings, speed } });
    void readAloudController.setSpeed(speed)?.then(reportError);
  };
  const speedLabel = gt("{speed}×", { speed: settings.speed });

  return (
    <ComposerSurface animateLayout={false} style={BAR_SHAPE}>
      <View
        accessibilityRole="toolbar"
        accessibilityLabel={gt("Read aloud")}
        className="h-11 flex-row items-center"
      >
        {status === "loading" ? (
          <View
            accessible
            accessibilityLabel={gt("Preparing speech")}
            accessibilityState={{ busy: true }}
            className="h-11 w-11 items-center justify-center"
          >
            <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
          </View>
        ) : (
          <BarButton
            label={status === "playing" ? gt("Pause reading") : gt("Resume reading")}
            icon={status === "playing" ? "pause.fill" : "play.fill"}
            onPress={() => {
              if (status === "playing") return readAloudController.pause();
              void readAloudController.resume().then(reportError);
            }}
          />
        )}
        {/* What it is doing; the way back to the word read takes its place once scrolled away. */}
        <View className="min-w-0 flex-1 flex-row items-center">
          {away?.id === id ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Jump to current")}
              className="h-11 min-w-0 shrink flex-row items-center gap-1 active:opacity-70"
              onPress={scrollToReadAloud}
            >
              <SymbolView
                name={away.side === "above" ? "arrow.up" : "arrow.down"}
                size={12}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
              <Text
                className="min-w-0 shrink font-t3-medium text-sm text-foreground"
                numberOfLines={1}
              >
                {gt("Jump to current")}
              </Text>
            </Pressable>
          ) : (
            <Text
              className="min-w-0 shrink font-t3-medium text-sm text-foreground"
              numberOfLines={1}
            >
              {status === "loading"
                ? gt("Preparing to read")
                : status === "paused"
                  ? gt("Paused")
                  : gt("Reading aloud")}
            </Text>
          )}
        </View>
        <View className="h-11 w-20 flex-row items-center">
          <VoiceWaveform audioLevels={status === "playing" ? levels : silent} />
        </View>
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={gt("Playback speed: {speed}×", { speed: settings.speed })}
          title={gt("Playback speed")}
          actions={SPEEDS.map((speed) => ({
            id: String(speed),
            title: gt("{speed}×", { speed }),
            state: speed === settings.speed ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => changeSpeed(Number(nativeEvent.event))}
        >
          {/* As wide as the widest speed, so picking one never moves the waveform. */}
          <View className="h-11 w-17 flex-row items-center justify-end gap-1">
            <Text className="font-t3-medium text-sm tabular-nums text-foreground-secondary">
              {speedLabel}
            </Text>
            <SymbolView
              name="chevron.down"
              size={10}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </View>
        </Menu>
        <BarButton label={gt("Stop reading")} icon="stop.fill" onPress={readAloudController.stop} />
      </View>
    </ComposerSurface>
  );
}

function BarButton(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      className="h-11 w-11 items-center justify-center active:opacity-70"
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={13}
        tintColorClassName="accent-foreground-secondary"
        type="monochrome"
      />
    </Pressable>
  );
}
