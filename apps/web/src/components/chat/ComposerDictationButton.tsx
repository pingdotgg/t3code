import { memo } from "react";
import { MicIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { DictationPhase } from "../../hooks/useComposerDictation";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerDictationButtonProps {
  readonly phase: DictationPhase;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

const DICTATION_TOOLTIPS: Record<DictationPhase, string> = {
  idle: "Dictate with microphone",
  requesting: "Waiting for microphone...",
  recording: "Stop recording and transcribe",
  transcribing: "Transcribing...",
};

const DICTATION_BUSY = new Set<DictationPhase>(["requesting", "transcribing"]);

export const ComposerDictationButton = memo(function ComposerDictationButton({
  phase,
  disabled,
  onToggle,
}: ComposerDictationButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onToggle}
            disabled={disabled || DICTATION_BUSY.has(phase)}
            aria-label={DICTATION_TOOLTIPS[phase]}
            aria-pressed={phase === "recording"}
            data-chat-composer-dictation={phase}
            className={cn(
              "relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/70 transition-all duration-150 hover:scale-105 hover:text-foreground/80 disabled:pointer-events-none disabled:opacity-30 sm:h-8 sm:w-8",
              phase === "recording" && "bg-destructive/10 text-destructive hover:text-destructive",
            )}
          />
        }
      >
        {DICTATION_BUSY.has(phase) ? (
          <Spinner className="size-3.5" aria-hidden="true" />
        ) : phase === "recording" ? (
          <span className="relative flex size-3.5 items-center justify-center" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/50" />
            <span className="relative inline-flex size-2 rounded-full bg-destructive" />
          </span>
        ) : (
          <MicIcon className="size-4" aria-hidden="true" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{DICTATION_TOOLTIPS[phase]}</TooltipPopup>
    </Tooltip>
  );
});
