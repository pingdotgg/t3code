import { PanelRightIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function OpenMessageSurfaceButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Open message as surface"
            onClick={onClick}
          />
        }
      >
        <PanelRightIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Open as surface</TooltipPopup>
    </Tooltip>
  );
}
