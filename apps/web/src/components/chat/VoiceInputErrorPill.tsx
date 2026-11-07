import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { RotateCcwIcon, SettingsIcon, XIcon } from "lucide-react";

import { useT } from "../../hooks/useI18n";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

const VOICE_ERROR_LABELS: Record<string, MessageKey> = {
  [MICROPHONE_PERMISSION_ERROR]: "voice.chat.error.microphonePermission",
  "Microphone access is required for voice input.": "voice.chat.error.microphonePermission",
  "This draft is no longer available.": "voice.chat.error.draftUnavailable",
  "Another voice recording is already active.": "voice.chat.error.anotherRecording",
  "Voice transcription is not available.": "voice.chat.error.unavailable",
  "Voice transcription is still finishing. Try again shortly.":
    "voice.chat.error.transcriptionBusy",
  "Voice transcription is not available for this language.": "voice.chat.error.languageUnsupported",
  "Could not prepare voice transcription.": "voice.chat.error.prepareFailed",
  "Could not start voice recording.": "voice.chat.error.startFailed",
  "Voice recording was interrupted.": "voice.chat.error.interrupted",
  "Could not finish voice recording.": "voice.chat.error.finishFailed",
  "Could not transcribe this recording.": "voice.chat.error.transcriptionFailed",
  "Voice transcription on this environment failed.": "voice.chat.error.transcriptionFailed",
  "The draft changed while voice input was running. The transcript was not added.":
    "voice.chat.error.draftChanged",
  "No speech was detected.": "voice.chat.error.noSpeech",
  "Microphone processing failed.": "voice.chat.error.microphoneProcessing",
  "The microphone disconnected.": "voice.chat.error.microphoneDisconnected",
};

function voiceErrorKey(error: string | null): MessageKey {
  return (error && VOICE_ERROR_LABELS[error]) || "voice.chat.error.failed";
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
  const t = useT();
  const openSettings = props.errorAction === "settings";
  const actionLabel = openSettings
    ? t("voice.chat.error.openSettings")
    : props.error === "Could not transcribe this recording." ||
        props.error === "Voice transcription on this environment failed."
      ? t("voice.chat.error.retryTranscription")
      : t("voice.chat.error.recordAgain");
  return (
    <VoiceInputPill>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm-pill"
              variant="ghost"
              aria-label={t("voice.chat.error.dismiss")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          {t("voice.chat.error.dismiss")}
          {props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={props.error ?? t("voice.chat.error.failed")}
              className="min-w-0 flex-1 truncate text-sm text-destructive"
            />
          }
        >
          {t(voiceErrorKey(props.error))}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.error ?? t("voice.chat.error.failed")}</TooltipPopup>
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
