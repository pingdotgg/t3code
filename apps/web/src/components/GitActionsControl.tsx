import { GitHubIcon } from "./Icons";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadId?: string;
  open?: boolean;
  onToggle?: () => void;
}

export default function GitActionsControl({ gitCwd, open, onToggle }: GitActionsControlProps) {
  const pressed = open ?? false;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0"
            pressed={pressed}
            onPressedChange={() => onToggle?.()}
            aria-label="Toggle GitHub panel"
            variant="outline"
            size="xs"
            disabled={!gitCwd}
          >
            <GitHubIcon className="size-3.5" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {pressed ? "Close GitHub panel" : "Open GitHub panel"}
      </TooltipPopup>
    </Tooltip>
  );
}
