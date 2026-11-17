import { useGT } from "gt-react-native";
import { useMediaAudioSessionHold } from "../../lib/videoAudioSession";
import { useFocusEffect } from "@react-navigation/native";
import { synthesizeEnvironmentSpeech } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { runSpeech } from "../voice-input/voiceDestination";
import { SpeechPlaybackSpeed } from "./SpeechPlaybackSpeed";
import { useSpeechOutputDestination } from "./useSpeechOutputDestination";
import { voiceOutput } from "./voiceOutput";

export function useResponseSpeechScope(owner: string, threadRef: ScopedThreadRef | null) {
  const { destination, playbackRate } = useSpeechOutputDestination(threadRef);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the native player with the saved playback speed
  useEffect(() => {
    if (voiceOutput.getSnapshot().owner?.startsWith(`${owner}:`))
      voiceOutput.setPlaybackRate(playbackRate);
  }, [owner, playbackRate]);
  const destinationKey = destination
    ? `${destination.environmentId}:${destination.engine}:${destination.voice ?? ""}`
    : "off";
  const active = useSyncExternalStore(voiceOutput.subscribe, () => {
    const snapshot = voiceOutput.getSnapshot();
    return Boolean(
      snapshot.owner?.startsWith(`${owner}:`) &&
      (snapshot.phase === "playing" || snapshot.phase === "paused"),
    );
  });
  useMediaAudioSessionHold(active);
  useFocusEffect(
    useCallback(() => {
      const stop = () => {
        if (voiceOutput.getSnapshot().owner?.startsWith(`${owner}:`)) voiceOutput.stop();
      };
      if (destinationKey === "off") stop();
      return stop;
    }, [owner, destinationKey]),
  );
}

export function ResponseSpeechButton(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  owner: string;
  text: string;
  tintColor: ColorValue;
  buttonSize: number;
  iconSize: number;
}) {
  const gt = useGT();
  const controls = useSpeechOutputDestination(props.threadRef);
  const { destination } = controls;
  const native = destination?.engine === "system";
  const targetId = destination?.environmentId ?? null;
  const prepared = Option.getOrNull(usePreparedConnection(targetId));
  const { presentation: environment } = useEnvironmentPresentation(targetId);
  const settings = environment?.serverConfig?.settings.speechOutput;
  const canOperate = useEnvironmentScope(targetId, AuthOrchestrationOperateScope);
  const phase = useSyncExternalStore(voiceOutput.subscribe, () => {
    const state = voiceOutput.getSnapshot();
    return state.owner === props.owner ? state.phase : "idle";
  });
  const active = phase !== "idle" && phase !== "error";
  if (
    !active &&
    (!destination ||
      (!native &&
        (!environment?.serverConfig?.environment.capabilities.voiceSynthesis ||
          !prepared ||
          !canOperate ||
          !settings)) ||
      !props.text.trim())
  )
    return null;
  const label =
    phase === "loading"
      ? "Cancel response audio"
      : phase === "playing" && !voiceOutput.canPause()
        ? "Stop response audio"
        : phase === "playing"
          ? "Pause response audio"
          : phase === "paused"
            ? "Resume response audio"
            : destination?.engine === "elevenlabs"
              ? "Read aloud using ElevenLabs"
              : destination?.engine === "openai"
                ? "Read aloud using OpenAI"
                : "Read aloud locally";
  const click = async () => {
    if (phase === "loading") {
      voiceOutput.stop();
      return;
    }
    if (phase === "playing" && !voiceOutput.canPause()) {
      voiceOutput.stop();
      return;
    }
    if (phase === "playing" || phase === "paused") {
      await voiceOutput.togglePause();
      return;
    }
    if (!destination || (!native && (!prepared || !canOperate || !settings))) return;
    voiceOutput.setPlaybackRate(controls.playbackRate);
    await voiceOutput.start(props.owner, props.text, async (text, signal) => {
      if (destination.engine === "system") return { text, voice: destination.voice ?? null };
      if (!prepared) throw new Error("Reconnect this environment before playing a response.");
      if (
        destination.voice &&
        !environment?.serverConfig?.environment.capabilities.voiceSynthesisOverrides
      )
        throw new Error(gt("Update the selected environment before using a custom speech voice."));
      return runSpeech(
        synthesizeEnvironmentSpeech(prepared, {
          text,
          engine: destination.engine,
          ...(destination.voice ? { voice: destination.voice } : {}),
        }),
        signal,
      );
    });
    const state = voiceOutput.getSnapshot();
    if (state.owner === props.owner && state.error)
      Dialog.alert("Could not read this response", state.error);
  };
  return (
    <View className="flex-row">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={8}
        onPress={() => void click()}
        style={{
          width: props.buttonSize,
          height: props.buttonSize,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <SymbolView
          name={
            phase === "loading" || (phase === "playing" && !voiceOutput.canPause())
              ? "stop.fill"
              : phase === "playing"
                ? "pause.fill"
                : phase === "paused"
                  ? "play.fill"
                  : "speaker.wave.2"
          }
          size={props.iconSize}
          tintColor={props.tintColor}
        />
      </Pressable>
      {active ? <SpeechPlaybackSpeed compact controls={controls} /> : null}
      {(phase === "playing" || phase === "paused") && voiceOutput.canPause() ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop response audio"
          hitSlop={8}
          onPress={voiceOutput.stop}
          style={{
            width: props.buttonSize,
            height: props.buttonSize,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SymbolView name={"stop.fill"} size={props.iconSize} tintColor={props.tintColor} />
        </Pressable>
      ) : null}
    </View>
  );
}
