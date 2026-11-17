import { msg, useGT, useMessages } from "gt-react";
import type { MessageResolver } from "~/i18n/messages";
import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

// The controller reports errors as text, resolved in English or the UI language.
const VOICE_ERROR_LABELS: ReadonlyArray<readonly [error: string, label: string]> = [
  [MICROPHONE_PERMISSION_ERROR, msg("Mic blocked")],
  [msg("Microphone access is required for voice input."), msg("Mic blocked")],
  [msg("This draft is no longer available."), msg("Draft unavailable")],
  [msg("Another voice recording is already active."), msg("Already recording")],
  [msg("Voice transcription is not available."), msg("Voice input unavailable")],
  [msg("Voice transcription is still finishing. Try again shortly."), msg("Still transcribing")],
  [msg("Voice transcription is not available for this language."), msg("Language unsupported")],
  [msg("Could not prepare voice transcription."), msg("Couldn’t start")],
  [msg("Could not start voice recording."), msg("Couldn’t start")],
  [msg("Voice recording was interrupted."), msg("Recording interrupted")],
  [msg("Could not finish voice recording."), msg("Couldn’t finish")],
  [msg("Could not transcribe this recording."), msg("Transcription failed")],
  [msg("Voice transcription on this environment failed."), msg("Transcription failed")],
  [
    msg("The draft changed while voice input was running. The transcript was not added."),
    msg("Draft changed"),
  ],
  [msg("No speech was detected."), msg("No speech heard")],
  [msg("Microphone processing failed."), msg("Mic failed")],
  [msg("The microphone disconnected."), msg("Mic disconnected")],
];

const RETRYABLE_TRANSCRIPTIONS = [
  msg("Could not transcribe this recording."),
  msg("Voice transcription on this environment failed."),
];

function isVoiceError(error: string, source: string, resolve: MessageResolver): boolean {
  return error === source || error === resolve(source);
}

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  disabled?: boolean;
  cancelShortcutLabel?: string | null;
  size?: "default" | "compact" | undefined;
  onRetry(): void;
  onDismiss(): void;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const message = props.error ?? gt("Voice input failed");
  const openSettings = props.errorAction === "settings";
  const compact = props.size === "compact";
  const error = props.error;
  const errorLabel = error
    ? VOICE_ERROR_LABELS.find(([source]) => isVoiceError(error, source, m))?.[1]
    : undefined;
  const action = openSettings
    ? { label: gt("Open voice settings"), text: gt("Settings") }
    : error && RETRYABLE_TRANSCRIPTIONS.some((source) => isVoiceError(error, source, m))
      ? {
          label: gt("Retry transcription"),
          text: gt("Retry", { $context: "verb, retries transcription" }),
        }
      : { label: gt("Record again"), text: gt("Record again") };
  return (
    <VoiceInputPill tone="error" size={props.size}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size={compact ? "icon-xs" : "icon-sm-pill"}
              variant="ghost"
              aria-label={gt("Dismiss voice input error")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
              className="shrink-0"
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          {props.cancelShortcutLabel
            ? gt("Dismiss ({shortcut})", { shortcut: props.cancelShortcutLabel })
            : gt("Dismiss")}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={message}
              className="flex min-w-0 items-center gap-1.5 rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            />
          }
        >
          <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{errorLabel ? m(errorLabel) : gt("Voice input failed")}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{message}</TooltipPopup>
      </Tooltip>
      {props.errorAction ? (
        <Button
          type="button"
          size={compact ? "xs" : "sm-pill"}
          variant="outline"
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
