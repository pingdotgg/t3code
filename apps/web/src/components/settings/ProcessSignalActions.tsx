import type { ServerProcessSignal } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";

import { InlineButton } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

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
      <SharedTooltipTrigger
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
        label={
          <>
            <T>
              Send <Var>{"SIGINT"}</Var>
            </T>
          </>
        }
      />
      <SharedTooltipTrigger
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
        label={
          <>
            <T>
              Send <Var>{"SIGKILL"}</Var>
            </T>
          </>
        }
      />
    </div>
  );
}
