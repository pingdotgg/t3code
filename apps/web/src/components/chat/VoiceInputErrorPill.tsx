import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { RotateCcwIcon, SettingsIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

const VOICE_ERROR_LABELS: Record<string, string> = {
  get [MICROPHONE_PERMISSION_ERROR]() {
    return t({ message: "Microphone access needed" });
  },
  get "Microphone access is required for voice input."() {
    return t({ message: "Microphone access needed" });
  },
  get "This draft is no longer available."() {
    return t({ message: "Draft unavailable" });
  },
  get "Another voice recording is already active."() {
    return t({ message: "Another recording active" });
  },
  get "Voice transcription is not available."() {
    return t({ message: "Voice input unavailable" });
  },
  get "Voice transcription is still finishing. Try again shortly."() {
    return t({ message: "Transcription still busy" });
  },
  get "Voice transcription is not available for this language."() {
    return t({ message: "Language unsupported" });
  },
  get "Could not prepare voice transcription."() {
    return t({ message: "Couldn’t prepare dictation" });
  },
  get "Could not start voice recording."() {
    return t({ message: "Couldn’t start recording" });
  },
  get "Voice recording was interrupted."() {
    return t({ message: "Recording interrupted" });
  },
  get "Could not finish voice recording."() {
    return t({ message: "Couldn’t finish recording" });
  },
  get "Could not transcribe this recording."() {
    return t({ message: "Transcription failed" });
  },
  get "Voice transcription on this environment failed."() {
    return t({ message: "Transcription failed" });
  },
  get "The draft changed while voice input was running. The transcript was not added."() {
    return t({ message: "Draft changed" });
  },
  get "No speech was detected."() {
    return t({ message: "No speech detected" });
  },
  get "Microphone processing failed."() {
    return t({ message: "Microphone processing failed" });
  },
  get "The microphone disconnected."() {
    return t({ message: "Microphone disconnected" });
  },
};

function voiceErrorLabel(error: string | null): string {
  return (error && VOICE_ERROR_LABELS[error]) || t({ message: "Voice input failed" });
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
    ? t({ message: "Open voice settings" })
    : props.error === "Could not transcribe this recording." ||
        props.error === "Voice transcription on this environment failed."
      ? t({ message: "Retry transcription" })
      : t({ message: "Record again" });
  return (
    <VoiceInputPill>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm-pill"
              variant="ghost"
              aria-label={t({ message: "Dismiss voice input error" })}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          <Trans>Dismiss voice input error</Trans>
          {props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={props.error ?? t({ message: "Voice input failed" })}
              className="min-w-0 flex-1 truncate text-sm text-destructive"
            />
          }
        >
          {voiceErrorLabel(props.error)}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.error ?? <Trans>Voice input failed</Trans>}</TooltipPopup>
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
