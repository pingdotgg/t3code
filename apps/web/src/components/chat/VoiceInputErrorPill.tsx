import {
  MICROPHONE_PERMISSION_ERROR,
  RETAINED_RECORDING_ERROR,
} from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { RotateCcwIcon, SettingsIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

const VOICE_ERROR_LABELS: Record<string, string> = {
  [MICROPHONE_PERMISSION_ERROR]: "Microphone access needed",
  "Microphone access is required for voice input.": "Microphone access needed",
  "This draft is no longer available.": "Draft unavailable",
  "Another voice recording is already active.": "Another recording active",
  "Voice transcription is not available.": "Voice input unavailable",
  "Voice transcription is still finishing. Try again shortly.": "Transcription still busy",
  "Voice transcription is not available for this language.": "Language unsupported",
  "Could not prepare voice transcription.": "Couldn’t prepare dictation",
  "Could not start voice recording.": "Couldn’t start recording",
  "Voice recording was interrupted.": "Recording interrupted",
  "Could not finish voice recording.": "Couldn’t finish recording",
  [RETAINED_RECORDING_ERROR]: "Transcription failed",
  "Voice transcription on this environment failed.": "Transcription failed",
  "The draft changed while voice input was running. The transcript was not added.": "Draft changed",
  "No speech was detected.": "No speech detected",
  "Microphone processing failed.": "Microphone processing failed",
  "The microphone disconnected.": "Microphone disconnected",
};

function voiceErrorLabel(error: string | null): string {
  return (error && VOICE_ERROR_LABELS[error]) || "Voice input failed";
}

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  disabled?: boolean;
  cancelShortcutLabel?: string | null;
  onRetry(): void;
  onDismiss(): void;
}) {
  const navigate = useNavigate();
  const openSettings = props.errorAction === "settings";
  const retryTranscription =
    props.error === RETAINED_RECORDING_ERROR ||
    props.error === "Voice transcription on this environment failed.";
  const actionLabel = openSettings
    ? "Open voice settings"
    : retryTranscription
      ? "Retry transcription"
      : "Record again";
  return (
    <VoiceInputPill>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm-pill"
              variant="ghost"
              aria-label="Dismiss voice input error"
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          Dismiss voice input error
          {props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={props.error ?? "Voice input failed"}
              className="min-w-0 flex-1 truncate text-sm text-destructive"
            />
          }
        >
          {voiceErrorLabel(props.error)}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.error ?? "Voice input failed"}</TooltipPopup>
      </Tooltip>
      {props.errorAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size={retryTranscription && !openSettings ? "sm-pill" : "icon-sm-pill"}
                variant={retryTranscription && !openSettings ? "outline" : "ghost"}
                aria-label={actionLabel}
                disabled={props.disabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (openSettings) {
                    props.onDismiss();
                    void navigate({ to: "/settings/voice" });
                  } else {
                    props.onRetry();
                  }
                }}
              >
                {openSettings ? <SettingsIcon /> : <RotateCcwIcon />}
                {retryTranscription && !openSettings ? "Retry" : null}
              </Button>
            }
          />
          <TooltipPopup side="top">{actionLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </VoiceInputPill>
  );
}
