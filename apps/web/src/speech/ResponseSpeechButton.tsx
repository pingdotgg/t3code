import { useGT } from "gt-react";
import { SpeechPlaybackSpeed } from "./SpeechPlaybackSpeed";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  SpeechPlaybackSettingsContext,
  useSpeechOutputDestination,
} from "./useSpeechOutputDestination";
import { synthesizeEnvironmentSpeech } from "@t3tools/client-runtime/voice-input";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { PauseIcon, PlayIcon, SquareIcon, Volume2Icon } from "lucide-react";
import * as Option from "effect/Option";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useEnvironment } from "../state/environments";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { toastManager } from "../components/ui/toast";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { isVoiceRecordingActive, voiceOutput } from "./voiceOutput";

export function ResponseSpeechScope({ owner, children }: { owner: string; children: ReactNode }) {
  const controls = useSpeechOutputDestination(parseScopedThreadKey(owner));
  const { destination, playbackRate } = controls;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the external player with the saved speed, including changes from other tabs
  useEffect(() => {
    if (voiceOutput.getSnapshot().owner?.startsWith(`${owner}:`))
      voiceOutput.setPlaybackRate(playbackRate);
  }, [owner, playbackRate]);
  const destinationKey = destination
    ? `${destination.environmentId}:${destination.engine}:${destination.voice ?? ""}`
    : "off";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the external player when this thread closes or its playback destination changes
  useEffect(() => {
    const stop = () => {
      if (voiceOutput.getSnapshot().owner?.startsWith(`${owner}:`)) voiceOutput.stop();
    };
    if (destinationKey === "off") stop();
    return stop;
  }, [owner, destinationKey]);
  return <SpeechPlaybackSettingsContext value={controls}>{children}</SpeechPlaybackSettingsContext>;
}

export function ResponseSpeechButton(props: {
  environmentId: EnvironmentId;
  owner: string;
  text: string;
}) {
  const gt = useGT();
  const { destination, playbackRate } = useSpeechOutputDestination();
  const native = destination?.engine === "system";
  const targetId = destination?.environmentId ?? null;
  const prepared = Option.getOrNull(usePreparedConnection(targetId));
  const settings = useEnvironmentSettings(targetId ?? props.environmentId);
  const environment = useEnvironment(targetId ?? props.environmentId);
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
          !settings?.speechOutput)) ||
      !props.text.trim())
  )
    return null;
  const label =
    phase === "loading"
      ? gt("Cancel response audio")
      : phase === "playing"
        ? gt("Pause response audio")
        : phase === "paused"
          ? gt("Resume response audio")
          : destination?.engine === "elevenlabs"
            ? gt("Read aloud using ElevenLabs")
            : destination?.engine === "openai"
              ? gt("Read aloud using OpenAI")
              : gt("Read aloud locally");
  const Icon =
    phase === "loading"
      ? SquareIcon
      : phase === "playing"
        ? PauseIcon
        : phase === "paused"
          ? PlayIcon
          : Volume2Icon;
  const click = async () => {
    if (phase === "loading") {
      voiceOutput.stop();
      return;
    }
    if (phase === "playing" || phase === "paused") {
      await voiceOutput.togglePause();
      return;
    }
    if (!destination || (!native && (!prepared || !canOperate || !settings?.speechOutput))) return;
    if (isVoiceRecordingActive()) {
      toastManager.add({
        type: "warning",
        title: gt("Finish dictation before playing a response"),
      });
      return;
    }
    const engine = destination.engine;
    voiceOutput.setPlaybackRate(playbackRate);
    await voiceOutput.start(props.owner, props.text, async (text, signal) => {
      if (engine === "system") return { text, voice: destination.voice ?? null };
      if (!prepared) throw new Error(gt("Reconnect this environment before playing a response."));
      if (
        destination.voice &&
        !environment?.serverConfig?.environment.capabilities.voiceSynthesisOverrides
      )
        throw new Error(gt("Update the selected environment before using a custom speech voice."));
      return runEnvironmentSpeech(
        synthesizeEnvironmentSpeech(prepared, {
          text,
          engine,
          ...(destination.voice ? { voice: destination.voice } : {}),
        }),
        { signal },
      );
    });
    const result = voiceOutput.getSnapshot();
    if (result.owner === props.owner && result.error)
      toastManager.add({
        type: "error",
        title: gt("Could not read this response"),
        description: result.error,
      });
  };
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-label={label}
              aria-pressed={active}
              onClick={() => void click()}
            />
          }
        >
          <Icon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      {active ? (
        <div className="w-16">
          <SpeechPlaybackSpeed compact />
        </div>
      ) : null}
      {phase === "playing" || phase === "paused" ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-label={gt("Stop response audio")}
          onClick={voiceOutput.stop}
        >
          <SquareIcon className="size-3" />
        </Button>
      ) : null}
    </>
  );
}
