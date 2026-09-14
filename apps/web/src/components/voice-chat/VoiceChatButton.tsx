import { AudioLinesIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function VoiceChatButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Start voice chat"
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onClick}
          />
        }
      >
        <AudioLinesIcon />
      </TooltipTrigger>
      <TooltipPopup>Start voice chat</TooltipPopup>
    </Tooltip>
  );
}
