import { XIcon } from "lucide-react";
import { use } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChatPaneContext } from "./chatPane";

/** Closes this split pane; renders nothing outside a split. Its thread keeps running. */
export function ChatPaneCloseButton() {
  const chatPane = use(ChatPaneContext);
  if (chatPane === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Close pane"
            size="icon-xs"
            variant="ghost-muted"
            onClick={chatPane.close}
          />
        }
      >
        <XIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close pane</TooltipPopup>
    </Tooltip>
  );
}
