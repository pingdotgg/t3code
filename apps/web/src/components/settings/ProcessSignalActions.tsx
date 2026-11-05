import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import type { ServerProcessSignal } from "@t3tools/contracts";

import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
              aria-label={t({ message: "Send SIGINT" })}
              tone="muted"
              onClick={() => onSignal("SIGINT")}
            >
              <Trans>INT</Trans>
            </InlineButton>
          }
        />
        <TooltipPopup side="top">
          <Trans>Send SIGINT</Trans>
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              disabled={disabled}
              aria-label={t({ message: "Send SIGKILL" })}
              tone="destructive"
              onClick={() => onSignal("SIGKILL")}
            >
              <Trans>KILL</Trans>
            </InlineButton>
          }
        />
        <TooltipPopup side="top">
          <Trans>Send SIGKILL</Trans>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
