import { msg, useGT, useMessages } from "gt-react";
import type { VoiceInputErrorCode } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

const VOICE_ERROR_LABELS: Readonly<Record<VoiceInputErrorCode, string>> = {
  "microphone-blocked": msg("Mic blocked"),
  "draft-unavailable": msg("Draft unavailable"),
  "already-recording": msg("Already recording"),
  unavailable: msg("Voice input unavailable"),
  "still-transcribing": msg("Still transcribing"),
  "language-unsupported": msg("Language unsupported"),
  "start-failed": msg("Couldn’t start"),
  interrupted: msg("Recording interrupted"),
  "finish-failed": msg("Couldn’t finish"),
  "transcription-failed": msg("Transcription failed"),
  "draft-changed": msg("Draft changed"),
  "no-speech": msg("No speech heard"),
  "microphone-failed": msg("Mic failed"),
  "microphone-disconnected": msg("Mic disconnected"),
};

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  errorCode?: VoiceInputErrorCode | undefined;
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
  const errorLabel = props.errorCode ? VOICE_ERROR_LABELS[props.errorCode] : undefined;
  const action = openSettings
    ? { label: gt("Open voice settings"), text: gt("Settings") }
    : props.errorCode === "transcription-failed"
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
              size={compact ? "icon-xs-pill" : "icon-sm-pill"}
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
          size={compact ? "xs-pill" : "sm-pill"}
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
