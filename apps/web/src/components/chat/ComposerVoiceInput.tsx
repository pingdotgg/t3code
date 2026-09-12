import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { ProviderDriverKind } from "@t3tools/contracts";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { createCodexVoiceTranscriber } from "../../voice/codexVoiceTranscriber";
import { useCodexVoiceAvailability } from "../../voice/codexVoiceAvailability";
import {
  ComposerVoiceSession,
  createMediaRecorderVoiceRecorder,
  formatVoiceElapsed,
  IDLE_COMPOSER_VOICE_STATE,
  requestComposerMicrophone,
  resolveVoiceMicAvailability,
  type ComposerVoiceCommit,
  type ComposerVoiceDraft,
  type ComposerVoiceTranscriber,
} from "../../voice/composerVoiceSession";

// TODO(composer.dictate): bind `composer.dictate` (default mod+shift+D) to
// start/stop once the command ships in contracts STATIC_KEYBINDING_COMMANDS +
// shared DEFAULT_KEYBINDINGS. Adding it now would break keybindings
// validation against servers that do not know the command yet. The mic button
// below is the supported entry point until then.

// Static levels keep the recording affordance cheap: no timers, meters, or
// animations repaint while recording (timer text updates at 2 Hz only).
const VOICE_WAVEFORM_BARS = [9, 15, 21, 12, 24, 17, 10, 19, 13, 22, 11, 16];

export const ComposerVoiceInput = memo(function ComposerVoiceInput(props: {
  readonly driverKind: ProviderDriverKind;
  readonly composerDisabled: boolean;
  readonly readDraft: () => ComposerVoiceDraft | null;
  readonly commitDraft: (commit: ComposerVoiceCommit) => boolean;
  readonly transcribe?: ComposerVoiceTranscriber;
  readonly onBusyChange?: (busy: boolean) => void;
}) {
  const [voiceState, setVoiceState] = useState<VoiceInputState>(IDLE_COMPOSER_VOICE_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const latestRef = useRef({ readDraft: props.readDraft, commitDraft: props.commitDraft });
  latestRef.current = { readDraft: props.readDraft, commitDraft: props.commitDraft };
  const busyRef = useRef(props.onBusyChange);
  busyRef.current = props.onBusyChange;

  const transcriber = useMemo(
    () => props.transcribe ?? createCodexVoiceTranscriber(),
    [props.transcribe],
  );
  const transcriberRef = useRef(transcriber);
  transcriberRef.current = transcriber;

  const sessionRef = useRef<ComposerVoiceSession | null>(null);
  useEffect(() => {
    // Constructed here (not during render) so StrictMode effect replay
    // leaves a usable session: the replayed cleanup nulls the ref, and this
    // setup re-creates it. All dependencies are refs, so the session always
    // calls through to the latest props.
    const session = new ComposerVoiceSession({
      readDraft: () => latestRef.current.readDraft(),
      commitDraft: (commit) => latestRef.current.commitDraft(commit),
      transcribe: (audio, options) => transcriberRef.current(audio, options),
      requestMicrophone: requestComposerMicrophone,
      createRecorder: createMediaRecorderVoiceRecorder,
      onStateChange: (next) => {
        setVoiceState(next);
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
  }, []);

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
  // Authoritative availability comes from GET /api/voice/availability;
  // the driver gate keeps the mic visible-but-disabled ("coming soon") for
  // every non-Codex provider.
  const serverVoiceAvailable = useCodexVoiceAvailability();
  const availability = resolveVoiceMicAvailability({
    driverKind: props.driverKind,
    codexVoiceAvailable: serverVoiceAvailable === true,
    composerDisabled: props.composerDisabled,
  });
  const availabilityLoading = props.driverKind === "codex" && serverVoiceAvailable === null;

  const handleStart = () => {
    setElapsedSeconds(0);
    void sessionRef.current?.start();
  };

  if (!busy && voiceState.phase !== "error") {
    const startTooltip = availabilityLoading
      ? "Checking voice input availability…"
      : availability.available
        ? "Dictate"
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
      className="relative flex shrink-0 items-center"
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
          <span aria-hidden="true" className="flex items-center gap-[2px] text-current opacity-40">
            {VOICE_WAVEFORM_BARS.map((height) => (
              <span key={height} className="w-[2.5px] rounded-full bg-current" style={{ height }} />
            ))}
          </span>
          <span
            aria-hidden="true"
            className="ms-1.5 min-w-9 text-xs text-muted-foreground tabular-nums"
          >
            {formatVoiceElapsed(elapsedSeconds)}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => sessionRef.current?.cancel()}
                  aria-label="Cancel dictation"
                />
              }
            >
              <XIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="top">Cancel dictation</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => void sessionRef.current?.stop()}
                  aria-label="Stop recording and transcribe"
                  aria-pressed="true"
                />
              }
            >
              <SquareIcon className="size-3.5 fill-current" />
            </TooltipTrigger>
            <TooltipPopup side="top">Stop recording and transcribe</TooltipPopup>
          </Tooltip>
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
            variant="ghost"
            size="icon-sm"
            disabled
            aria-label={
              voiceState.phase === "preparing" ? "Starting voice input" : "Transcribing voice input"
            }
          >
            <Spinner className="size-4" aria-hidden="true" />
          </Button>
          <span className="sr-only" role="status">
            {voiceState.phase === "preparing" ? "Starting voice input" : "Transcribing voice input"}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => sessionRef.current?.cancel()}
                  aria-label="Cancel voice input"
                />
              }
            >
              <XIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="top">Cancel voice input</TooltipPopup>
          </Tooltip>
        </>
      )}
    </div>
  );
});
