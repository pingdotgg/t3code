import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createDictationFormatter } from "@t3tools/shared/voicePunctuation";
import { useEnvironmentSettings } from "../../hooks/useSettings";

import { ComposerVoicePolish } from "./ComposerVoicePolish";
import { VoiceWaveform } from "./VoiceWaveform";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { createCodexVoiceRecorder } from "../../voice/codexVoiceRecorder";
import { useCodexVoiceAvailability } from "../../voice/codexVoiceAvailability";
import {
  ComposerVoiceSession,
  formatVoiceElapsed,
  IDLE_COMPOSER_VOICE_STATE,
  requestComposerMicrophone,
  resolveVoiceMicAvailability,
  type ComposerVoiceCommit,
  type ComposerVoiceDraft,
} from "../../voice/composerVoiceSession";

// TODO(composer.dictate): bind `composer.dictate` (default mod+shift+D) to
// start/stop once the command ships in contracts STATIC_KEYBINDING_COMMANDS +
// shared DEFAULT_KEYBINDINGS. Adding it now would break keybindings
// validation against servers that do not know the command yet. The mic button
// below is the supported entry point until then.

export const ComposerVoiceInput = memo(function ComposerVoiceInput(props: ComposerVoiceInputProps) {
  return props.driverKind === "codex" ? <CodexComposerVoiceInput {...props} /> : null;
});

type ComposerVoiceInputProps = {
  readonly driverKind: ProviderDriverKind;
  readonly composerDisabled: boolean;
  readonly readDraft: () => ComposerVoiceDraft | null;
  readonly commitDraft: (commit: ComposerVoiceCommit) => boolean;
  readonly instanceId: ProviderInstanceId;
  readonly environmentId: EnvironmentId;
  readonly focusDraft: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
};

function CodexComposerVoiceInput(props: ComposerVoiceInputProps) {
  const [voiceState, setVoiceState] = useState<VoiceInputState>(IDLE_COMPOSER_VOICE_STATE);
  const [completedDraft, setCompletedDraft] = useState<ComposerVoiceDraft | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [captureStream, setCaptureStream] = useState<MediaStream | null>(null);
  const dictation = useEnvironmentSettings(props.environmentId, (settings) => settings.dictation);
  const formatTranscript = useMemo(() => createDictationFormatter(dictation), [dictation]);

  const latestRef = useRef({
    readDraft: props.readDraft,
    commitDraft: props.commitDraft,
    formatTranscript,
  });
  const busyRef = useRef(props.onBusyChange);
  useLayoutEffect(() => {
    latestRef.current = {
      readDraft: props.readDraft,
      commitDraft: props.commitDraft,
      formatTranscript,
    };
    busyRef.current = props.onBusyChange;
  });

  const sessionRef = useRef<ComposerVoiceSession | null>(null);
  useEffect(() => {
    // Constructed here (not during render) so StrictMode effect replay
    // leaves a usable session: the replayed cleanup nulls the ref, and this
    // setup re-creates it. All dependencies are refs, so the session always
    // calls through to the latest props.
    const session = new ComposerVoiceSession({
      readDraft: () => latestRef.current.readDraft(),
      commitDraft: (commit) => latestRef.current.commitDraft(commit),
      formatTranscript: (text) => latestRef.current.formatTranscript(text),
      requestMicrophone: async () => {
        const stream = await requestComposerMicrophone();
        if (sessionRef.current === session && session.busy) setCaptureStream(stream);
        return stream;
      },
      createRecorder: (stream, callbacks) => {
        const recorder = createCodexVoiceRecorder(
          props.environmentId,
          props.instanceId,
          stream,
          callbacks,
        );
        return recorder;
      },
      onComplete: setCompletedDraft,
      onStateChange: (next) => {
        setVoiceState(next);
        if (next.phase !== "recording" && next.phase !== "preparing") setCaptureStream(null);
        busyRef.current?.(voiceInputBlocksSubmission(next));
      },
    });
    sessionRef.current = session;
    return () => {
      session.dispose();
      sessionRef.current = null;
      // The parent keys this input by draft target and lifts `busy` to gate
      // Send. dispose() emits no state change, so clear the lifted flag here;
      // otherwise a target switch mid-recording leaves Send disabled forever.
      busyRef.current?.(false);
    };
  }, [props.environmentId, props.instanceId]);

  useEffect(() => {
    if (voiceState.phase !== "recording") return;
    const timerId = window.setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      session.tick();
      setElapsedSeconds(session.getElapsedSeconds());
    }, 500);
    return () => window.clearInterval(timerId);
  }, [voiceState.phase]);

  const busy = voiceInputBlocksSubmission(voiceState);
  // Only supported providers mount this input or probe availability.
  const { available: serverVoiceAvailable, prepare: prepareVoice } = useCodexVoiceAvailability(
    props.environmentId,
    props.instanceId,
    props.driverKind === "codex",
  );
  const availability = resolveVoiceMicAvailability({
    driverKind: props.driverKind,
    codexVoiceAvailable: serverVoiceAvailable === true,
    composerDisabled: props.composerDisabled,
  });
  const availabilityLoading = props.driverKind === "codex" && serverVoiceAvailable === null;

  const handleStart = () => {
    setCompletedDraft(null);
    setElapsedSeconds(0);
    props.focusDraft();
    prepareVoice();
    void sessionRef.current?.start();
  };

  const renderInput = () => {
    if (!busy && voiceState.phase !== "error") {
      const startTooltip = availabilityLoading
        ? "Checking voice input availability…"
        : availability.available
          ? "Dictate with Codex - keeps recording in the background"
          : availability.reason;
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              availability.available ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={handleStart}
                  onPointerEnter={prepareVoice}
                  onFocus={prepareVoice}
                  aria-label="Dictate"
                  data-chat-composer-voice="idle"
                />
              ) : (
                <span className="inline-flex shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled
                    aria-label={startTooltip}
                    data-chat-composer-voice="unavailable"
                  />
                </span>
              )
            }
          >
            <MicIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="top">{startTooltip}</TooltipPopup>
        </Tooltip>
      );
    }

    return (
      <div
        className={
          busy
            ? "relative flex min-w-0 flex-1 items-center gap-3"
            : "relative flex shrink-0 items-center"
        }
        data-chat-composer-voice={voiceState.phase}
      >
        {voiceState.phase === "error" ? (
          <div
            role="alert"
            className="absolute right-0 bottom-full z-10 mb-2 w-64 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
          >
            <p className="text-xs">{voiceState.error ?? "Voice input failed."}</p>
            <div className="mt-1.5 flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="micro"
                onClick={() => sessionRef.current?.dismissError()}
              >
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}
        {voiceState.phase === "recording" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="shrink-0 rounded-full"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => sessionRef.current?.cancel()}
              aria-label="Cancel dictation and keep inserted text"
              title="Cancel dictation and keep inserted text"
            >
              <XIcon className="size-4" />
            </Button>
            <VoiceWaveform stream={captureStream} />
            <span
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
              aria-label="Recording time"
            >
              {formatVoiceElapsed(elapsedSeconds)}
            </span>
            <Button
              type="button"
              variant="default"
              size="icon-sm"
              className="shrink-0 rounded-full"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void sessionRef.current?.stop()}
              aria-label="Stop dictation"
              title="Stop dictation"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </Button>
            <span className="sr-only" role="status">
              Recording. Continues in the background for up to five minutes. Stop or cancel at any
              time.
            </span>
          </>
        ) : voiceState.phase === "error" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                availability.available ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={handleStart}
                    aria-label="Retry dictation"
                  />
                ) : (
                  <span className="inline-flex shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled
                      aria-label={availability.reason}
                    />
                  </span>
                )
              }
            >
              <MicIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {availability.available ? "Retry dictation" : availability.reason}
            </TooltipPopup>
          </Tooltip>
        ) : (
          <>
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="shrink-0 rounded-full"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => sessionRef.current?.cancel()}
              aria-label="Cancel voice input"
              title="Cancel voice input"
            >
              <XIcon className="size-4" />
            </Button>
            <span
              className="flex min-w-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
              role="status"
            >
              <Spinner className="size-4" aria-hidden="true" />
              {voiceState.phase === "preparing"
                ? "Connecting microphone…"
                : "Finishing last words…"}
            </span>
          </>
        )}
      </div>
    );
  };
  return (
    <div className={`flex min-w-0 items-center ${busy ? "flex-1 gap-1" : "shrink-0"}`}>
      {renderInput()}
      {props.driverKind === "codex" && (
        <ComposerVoicePolish
          environmentId={props.environmentId}
          instanceId={props.instanceId}
          disabled={props.composerDisabled}
          busy={busy}
          completedDraft={completedDraft}
          readDraft={props.readDraft}
          commitDraft={props.commitDraft}
        />
      )}
    </div>
  );
}
