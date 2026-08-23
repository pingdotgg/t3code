import type { DesktopSpeechStatus } from "@t3tools/contracts";
import { LoaderCircleIcon, MicIcon, SquareIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerSpeechButton(props: {
  status: DesktopSpeechStatus | null;
  progress: { downloaded: number; total: number } | null;
  level: number;
  disabled?: boolean;
  onStart(): void;
  onStop(): void;
  onCancel(): void;
}) {
  if (props.status?.supported === false) return null;
  const state = props.status?.supported ? props.status.state : "missing-model";
  const recording = state === "recording";
  const busy = state === "downloading" || state === "transcribing";
  const label = recording
    ? "Stop and transcribe"
    : state === "downloading"
      ? `Downloading speech model${props.progress ? ` ${Math.round((props.progress.downloaded / Math.max(1, props.progress.total)) * 100)}%` : ""}`
      : state === "transcribing"
        ? "Transcribing voice input"
        : state === "error"
          ? (props.status?.message ?? "Voice input failed")
          : "Start voice input";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={recording ? "destructive" : "ghost"}
            aria-label={label}
            aria-pressed={recording}
            disabled={props.disabled || busy}
            onClick={recording ? props.onStop : props.onStart}
            className="relative"
          >
            {recording ? (
              <>
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-[inherit] bg-white/20 transition-transform"
                  style={{ transform: `scale(${1 + Math.min(1, props.level) * 0.16})` }}
                />
                <SquareIcon className="relative size-3 fill-current" />
              </>
            ) : busy ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : state === "error" ? (
              <XIcon />
            ) : (
              <MicIcon />
            )}
          </Button>
        }
      />
      <TooltipPopup side="top">
        {label}
        {recording ? " · esc to cancel" : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
