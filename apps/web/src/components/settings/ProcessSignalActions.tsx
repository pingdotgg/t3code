import type { ServerProcessSignal } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";

import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SIGNAL_SHORT_NAMES = { SIGINT: "INT", SIGKILL: "KILL" } as const;

export function ProcessSignalActions({
  disabled,
  onSignal,
}: {
  disabled: boolean;
  onSignal: (signal: ServerProcessSignal) => void;
}) {
  const gt = useGT();
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              disabled={disabled}
              aria-label={gt("Send {signal}", { signal: "SIGINT" })}
              tone="muted"
              onClick={() => onSignal("SIGINT")}
            >
              {SIGNAL_SHORT_NAMES.SIGINT}
            </InlineButton>
          }
        />
        <TooltipPopup side="top">
          <T>
            Send <Var>{"SIGINT"}</Var>
          </T>
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              disabled={disabled}
              aria-label={gt("Send {signal}", { signal: "SIGKILL" })}
              tone="destructive"
              onClick={() => onSignal("SIGKILL")}
            >
              {SIGNAL_SHORT_NAMES.SIGKILL}
            </InlineButton>
          }
        />
        <TooltipPopup side="top">
          <T>
            Send <Var>{"SIGKILL"}</Var>
          </T>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
