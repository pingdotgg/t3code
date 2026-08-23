import type { DesktopSpeechStatus } from "@t3tools/contracts";
import { CircleAlertIcon, MicIcon, SquareIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

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
  const inactive = !recording && (props.disabled || busy);
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
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant={
                recording ? "destructive" : state === "error" ? "destructive-outline" : "ghost"
              }
              aria-label={label}
              aria-pressed={recording}
              aria-disabled={inactive}
              onClick={() => {
                if (inactive) return;
                if (recording) props.onStop();
                else props.onStart();
              }}
              className={cn("relative", inactive && "cursor-not-allowed opacity-64")}
            >
              {recording ? (
                <>
                  <span
                    aria-hidden
                    className="absolute inset-0 rounded-[inherit] bg-white/20 transition-transform motion-reduce:transition-none"
                    style={{ transform: `scale(${0.84 + Math.min(1, props.level) * 0.16})` }}
                  />
                  <SquareIcon className="relative size-3 fill-current" />
                </>
              ) : busy ? (
                <Spinner aria-hidden />
              ) : state === "error" ? (
                <CircleAlertIcon />
              ) : (
                <MicIcon />
              )}
            </Button>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      {recording ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Discard voice input"
                onClick={props.onCancel}
              >
                <XIcon />
              </Button>
            }
          />
          <TooltipPopup side="top">Discard voice input</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
