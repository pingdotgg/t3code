import type { ServerProcessSignal } from "@t3tools/contracts";

import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Process ownership and confirmation stay with the diagnostics view. */
export function ProcessSignalActions({
  disabled,
  onSignal,
}: {
  disabled: boolean;
  onSignal: (signal: ServerProcessSignal) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              disabled={disabled}
              aria-label="Send SIGINT"
              className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => onSignal("SIGINT")}
            >
              INT
            </InlineButton>
          }
        />
        <TooltipPopup side="top">Send SIGINT</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              disabled={disabled}
              aria-label="Send SIGKILL"
              className="text-[11px] font-medium text-destructive underline-offset-2 hover:underline"
              onClick={() => onSignal("SIGKILL")}
            >
              KILL
            </InlineButton>
          }
        />
        <TooltipPopup side="top">Send SIGKILL</TooltipPopup>
      </Tooltip>
    </div>
  );
}
