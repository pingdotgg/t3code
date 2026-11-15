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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends this thread's playback when navigation removes its timeline
  useEffect(
    () => () => {
      if (voiceOutput.getSnapshot().owner?.startsWith(`${owner}:`)) voiceOutput.stop();
    },
    [owner],
  );
  return children;
}

export function ResponseSpeechButton(props: {
  environmentId: EnvironmentId;
  owner: string;
  text: string;
}) {
  const prepared = Option.getOrNull(usePreparedConnection(props.environmentId));
  const settings = useEnvironmentSettings(props.environmentId);
  const environment = useEnvironment(props.environmentId);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const phase = useSyncExternalStore(voiceOutput.subscribe, () => {
    const state = voiceOutput.getSnapshot();
    return state.owner === props.owner ? state.phase : "idle";
  });
  if (
    !environment?.serverConfig?.environment.capabilities.voiceSynthesis ||
    !prepared ||
    !canOperate ||
    !settings?.speechOutput ||
    !props.text.trim()
  )
    return null;
  const active = phase !== "idle" && phase !== "error";
  const label =
    phase === "loading"
      ? "Cancel response audio"
      : phase === "playing"
        ? "Pause response audio"
        : phase === "paused"
          ? "Resume response audio"
          : settings.speechOutput.engine === "openai"
            ? "Read aloud using OpenAI"
            : "Read aloud locally";
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
    if (isVoiceRecordingActive()) {
      toastManager.add({ type: "warning", title: "Finish dictation before playing a response" });
      return;
    }
    const engine = settings.speechOutput.engine;
    await voiceOutput.start(props.owner, props.text, (text, signal) =>
      runEnvironmentSpeech(synthesizeEnvironmentSpeech(prepared, { text, engine }), { signal }),
    );
    const result = voiceOutput.getSnapshot();
    if (result.owner === props.owner && result.error)
      toastManager.add({
        type: "error",
        title: "Could not read this response",
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
      {phase === "playing" || phase === "paused" ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-label="Stop response audio"
          onClick={voiceOutput.stop}
        >
          <SquareIcon className="size-3" />
        </Button>
      ) : null}
    </>
  );
}
