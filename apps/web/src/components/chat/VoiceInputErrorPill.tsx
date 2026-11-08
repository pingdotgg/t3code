import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

const VOICE_ERROR_LABELS: Record<string, string> = {
  [MICROPHONE_PERMISSION_ERROR]: "Mic blocked",
  "Microphone access is required for voice input.": "Mic blocked",
  "This draft is no longer available.": "Draft unavailable",
  "Another voice recording is already active.": "Already recording",
  "Voice transcription is not available.": "Voice input unavailable",
  "Voice transcription is still finishing. Try again shortly.": "Still transcribing",
  "Voice transcription is not available for this language.": "Language unsupported",
  "Could not prepare voice transcription.": "Couldn’t start",
  "Could not start voice recording.": "Couldn’t start",
  "Voice recording was interrupted.": "Recording interrupted",
  "Could not finish voice recording.": "Couldn’t finish",
  "Could not transcribe this recording.": "Transcription failed",
  "Voice transcription on this environment failed.": "Transcription failed",
  "The draft changed while voice input was running. The transcript was not added.": "Draft changed",
  "No speech was detected.": "No speech heard",
  "Microphone processing failed.": "Mic failed",
  "The microphone disconnected.": "Mic disconnected",
};

const RETRYABLE_TRANSCRIPTIONS = new Set([
  "Could not transcribe this recording.",
  "Voice transcription on this environment failed.",
]);

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  disabled?: boolean;
  cancelShortcutLabel?: string | null;
  onRetry(): void;
  onDismiss(): void;
}) {
  const navigate = useNavigate();
  const message = props.error ?? "Voice input failed";
  const openSettings = props.errorAction === "settings";
  const action = openSettings
    ? { label: "Open voice settings", text: "Settings" }
    : props.error && RETRYABLE_TRANSCRIPTIONS.has(props.error)
      ? { label: "Retry transcription", text: "Retry" }
      : { label: "Record again", text: "Record again" };
  return (
    <VoiceInputPill tone="error">
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
              className="shrink-0"
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          Dismiss
          {props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={message}
              className="flex min-w-0 items-center gap-1.5 text-sm font-medium outline-none focus-visible:underline"
            />
          }
        >
          <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            {(props.error && VOICE_ERROR_LABELS[props.error]) || "Voice input failed"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{message}</TooltipPopup>
      </Tooltip>
      {props.errorAction ? (
        <Button
          type="button"
          size="sm-pill"
          variant="ghost"
          aria-label={action.label}
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
          className="ms-auto shrink-0"
        >
          {action.text}
        </Button>
      ) : (
        <span aria-hidden className="w-1.5 shrink-0" />
      )}
    </VoiceInputPill>
  );
}
