import { RotateCcwIcon, SettingsIcon, XIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { VoiceInputPill } from "./VoiceInputPill";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const VOICE_ERROR_LABELS: Record<string, string> = {
  "No audio was recorded. Try again.": "No audio recorded",
  "Could not record microphone audio. Try again.": "Recording failed",
  "Could not access the microphone.": "Microphone unavailable",
  "Microphone testing is unavailable in this browser. Use HTTPS or the desktop app.":
    "Microphone test unavailable",
  "Permission denied": "Microphone access needed",
  "Requested device not found": "Microphone not found",
  "This draft is no longer available.": "Draft unavailable",
  "Another voice recording is already active.": "Another recording active",
  "Voice transcription is not available.": "Voice input unavailable",
  "Microphone access is required for voice input.": "Microphone access needed",
  "Voice transcription is still finishing. Try again shortly.": "Transcription still busy",
  "Voice transcription is not available for this language.": "Language unsupported",
  "Could not prepare voice transcription.": "Couldn’t prepare dictation",
  "Could not start voice recording.": "Couldn’t start recording",
  "Voice recording was interrupted.": "Recording interrupted",
  "Voice input stopped when the app moved to the background.": "Recording stopped in background",
  "Could not finish voice recording.": "Couldn’t finish recording",
  "Could not transcribe this recording.": "Transcription failed",
  "The draft changed while voice input was running. The transcript was not added.": "Draft changed",
  "No speech was detected.": "No speech detected",
  "Microphone processing failed.": "Microphone processing failed",
  "The microphone disconnected.": "Microphone disconnected",
  "Could not prepare voice input.": "Couldn’t prepare dictation",
  "Reconnect the project environment to load its dictionary.": "Project disconnected",
  "Personal and project dictionaries together cannot exceed 100 words.":
    "Dictionary exceeds 100 words",
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
  const actionLabel = openSettings
    ? "Open voice settings"
    : props.error === "Could not transcribe this recording."
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
                size="icon-sm-pill"
                variant="ghost"
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
              </Button>
            }
          />
          <TooltipPopup side="top">{actionLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </VoiceInputPill>
  );
}
