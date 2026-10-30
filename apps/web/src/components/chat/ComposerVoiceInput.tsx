import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { useDesktopVoiceInput } from "../../hooks/useDesktopVoiceInput";

export function ComposerVoiceInput({
  voice,
  disabled,
}: {
  readonly voice: ReturnType<typeof useDesktopVoiceInput>;
  readonly disabled: boolean;
}) {
  if (!voice.available) return null;
  const recording = voice.phase === "recording";
  const label = recording ? "Finish voice input" : "Start voice input";
  return (
    <div className="flex items-center gap-1">
      {voice.busy ? (
        <span role="status" className="text-xs text-muted-foreground">
          {recording
            ? "Recording"
            : voice.phase === "preparing"
              ? "Preparing Apple speech…"
              : "Transcribing…"}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant={recording ? "destructive" : "ghost"}
              aria-label={label}
              aria-pressed={recording}
              disabled={!recording && (disabled || voice.busy)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (recording) void voice.stop();
                else void voice.start();
              }}
            >
              {recording ? (
                <CheckIcon />
              ) : voice.busy ? (
                <Spinner aria-hidden="true" />
              ) : (
                <MicIcon />
              )}
            </Button>
          }
        />
        <TooltipPopup>
          {recording
            ? "Finish and insert transcript"
            : "Dictate on your Mac. First use may download an Apple speech model."}
        </TooltipPopup>
      </Tooltip>
      {voice.busy ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Discard voice input"
          onPointerDown={(event) => event.preventDefault()}
          onClick={voice.cancel}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}
