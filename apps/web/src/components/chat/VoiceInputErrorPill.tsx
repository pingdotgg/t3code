import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { RotateCcwIcon, SettingsIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { translateDynamic } from "../../i18nCore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

// Keys are the raw provider error strings (data, not translated); values are composer label keys.
const VOICE_ERROR_LABELS: Record<string, string> = {
  [MICROPHONE_PERMISSION_ERROR]: "voiceError.microphoneAccess",
  "Microphone access is required for voice input.": "voiceError.microphoneAccess",
  "This draft is no longer available.": "voiceError.draftUnavailable",
  "Another voice recording is already active.": "voiceError.anotherRecording",
  "Voice transcription is not available.": "voiceError.unavailable",
  "Voice transcription is still finishing. Try again shortly.": "voiceError.transcriptionBusy",
  "Voice transcription is not available for this language.": "voiceError.languageUnsupported",
  "Could not prepare voice transcription.": "voiceError.couldNotPrepare",
  "Could not start voice recording.": "voiceError.couldNotStart",
  "Voice recording was interrupted.": "voiceError.recordingInterrupted",
  "Could not finish voice recording.": "voiceError.couldNotFinish",
  "Could not transcribe this recording.": "voiceError.transcriptionFailed",
  "Voice transcription on this environment failed.": "voiceError.transcriptionFailed",
  "The draft changed while voice input was running. The transcript was not added.":
    "voiceError.draftChanged",
  "No speech was detected.": "voiceError.noSpeech",
  "Microphone processing failed.": "voiceError.microphoneProcessingFailed",
  "The microphone disconnected.": "voiceError.microphoneDisconnected",
};

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  disabled?: boolean;
  cancelShortcutLabel?: string | null;
  onRetry(): void;
  onDismiss(): void;
}) {
  const { t } = useTranslation("composer");
  const navigate = useNavigate();
  const openSettings = props.errorAction === "settings";
  const actionLabel = openSettings
    ? t("voiceError.openSettings")
    : props.error === "Could not transcribe this recording." ||
        props.error === "Voice transcription on this environment failed."
      ? t("voiceError.retryTranscription")
      : t("voiceError.recordAgain");
  const voiceErrorKey = props.error ? VOICE_ERROR_LABELS[props.error] : undefined;
  const voiceErrorLabel =
    (voiceErrorKey ? translateDynamic(`composer:${voiceErrorKey}`) : "") || t("voiceError.failed");
  return (
    <VoiceInputPill>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm-pill"
              variant="ghost"
              aria-label={t("voiceError.dismiss")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          {t("voiceError.dismiss")}
          {props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={props.error ?? t("voiceError.failed")}
              className="min-w-0 flex-1 truncate text-sm text-destructive"
            />
          }
        >
          {voiceErrorLabel}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.error ?? t("voiceError.failed")}</TooltipPopup>
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
