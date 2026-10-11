import type { ServerProcessSignal } from "@t3tools/contracts";

import { InlineButton } from "../ui/button";
import { DiagnosticsTooltip } from "./DiagnosticsTooltip";

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
      <DiagnosticsTooltip
        tooltip="Send SIGINT"
        render={
          <InlineButton
            disabled={disabled}
            aria-label="Send SIGINT"
            tone="muted"
            onClick={() => onSignal("SIGINT")}
          >
            INT
          </InlineButton>
        }
      />
      <DiagnosticsTooltip
        tooltip="Send SIGKILL"
        render={
          <InlineButton
            disabled={disabled}
            aria-label="Send SIGKILL"
            tone="destructive"
            onClick={() => onSignal("SIGKILL")}
          >
            KILL
          </InlineButton>
        }
      />
    </div>
  );
}
