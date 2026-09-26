import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { useBrowserVoiceInput } from "./useBrowserVoiceInput";

export function ComposerVoiceInput({
  voice,
  disabled,
}: {
  voice: ReturnType<typeof useBrowserVoiceInput>;
  disabled: boolean;
}) {
  if (voice.busy) {
    return (
      <div className="flex items-center gap-1" aria-label="Voice input">
        <span className="text-xs text-muted-foreground" role="status">
          {voice.state.phase === "preparing"
            ? "Starting microphone…"
            : voice.state.phase === "transcribing"
              ? "Finishing…"
              : "Listening…"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel voice input"
          onClick={voice.cancel}
        >
          <XIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Finish voice input"
          disabled={voice.state.phase !== "recording"}
          onClick={voice.stop}
        >
          <CheckIcon />
        </Button>
      </div>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Start voice input"
          disabled={disabled || !voice.available}
          onPointerDown={(event) => event.preventDefault()}
          onClick={voice.start}
        >
          <MicIcon />
        </Button>
      </TooltipTrigger>
      <TooltipPopup>
        {voice.unavailableReason ??
          "Voice input. Your browser may send audio to its speech service."}
      </TooltipPopup>
    </Tooltip>
  );
}
