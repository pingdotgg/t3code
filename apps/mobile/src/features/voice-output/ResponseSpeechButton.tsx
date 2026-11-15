import { useMediaAudioSessionHold } from "../../lib/videoAudioSession";
import { useFocusEffect } from "@react-navigation/native";
import { synthesizeEnvironmentSpeech } from "@t3tools/client-runtime/voice-input";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useSyncExternalStore } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { runSpeech } from "../voice-input/voiceDestination";
import { voiceOutput } from "./voiceOutput";

export function useResponseSpeechScope(owner: string) {
  const active = useSyncExternalStore(voiceOutput.subscribe, () => {
    const snapshot = voiceOutput.getSnapshot();
    return Boolean(
      snapshot.owner?.startsWith(`${owner}:`) &&
      (snapshot.phase === "playing" || snapshot.phase === "paused"),
    );
  });
  useMediaAudioSessionHold(active);
  useFocusEffect(
    useCallback(
      () => () => {
        if (voiceOutput.getSnapshot().owner?.startsWith(`${owner}:`)) voiceOutput.stop();
      },
      [owner],
    ),
  );
}

export function ResponseSpeechButton(props: {
  environmentId: EnvironmentId;
  owner: string;
  text: string;
  tintColor: ColorValue;
  buttonSize: number;
  iconSize: number;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(props.environmentId));
  const { presentation: environment } = useEnvironmentPresentation(props.environmentId);
  const settings = environment?.serverConfig?.settings.speechOutput;
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const phase = useSyncExternalStore(voiceOutput.subscribe, () => {
    const state = voiceOutput.getSnapshot();
    return state.owner === props.owner ? state.phase : "idle";
  });
  const active = phase !== "idle" && phase !== "error";
  if (
    !active &&
    (!environment?.serverConfig?.environment.capabilities.voiceSynthesis ||
      !prepared ||
      !canOperate ||
      !settings ||
      !props.text.trim())
  )
    return null;
  const label =
    phase === "loading"
      ? "Cancel response audio"
      : phase === "playing"
        ? "Pause response audio"
        : phase === "paused"
          ? "Resume response audio"
          : settings?.engine === "openai"
            ? "Read aloud using OpenAI"
            : "Read aloud locally";
  const click = async () => {
    if (phase === "loading") {
      voiceOutput.stop();
      return;
    }
    if (phase === "playing" || phase === "paused") {
      await voiceOutput.togglePause();
      return;
    }
    if (!prepared || !canOperate || !settings) return;
    await voiceOutput.start(props.owner, props.text, (text, signal) =>
      runSpeech(synthesizeEnvironmentSpeech(prepared, { text, engine: settings.engine }), signal),
    );
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
            phase === "loading"
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
      {phase === "playing" || phase === "paused" ? (
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
