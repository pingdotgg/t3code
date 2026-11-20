import type { UserShellItem } from "@t3tools/client-runtime/state/user-shell-commands";
import type { EnvironmentId } from "@t3tools/contracts";
import { TerminalIcon, XIcon } from "lucide-react";
import { useGT } from "gt-react";
import { memo } from "react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useUserShellCommandActions } from "./userShellCommands";

function shellResultTooltip(item: UserShellItem, gt: ReturnType<typeof useGT>): string {
  if (item.status === "running") {
    return gt("Still running. Its output so far goes with your next message.");
  }
  if (item.userShell.stoppedByUser) return gt("Stopped. Its output goes with your next message.");
  if (item.exitCode !== undefined) {
    return gt("Exited with code {code}. Its output goes with your next message.", {
      code: item.exitCode,
    });
  }
  return gt("Its output goes with your next message.");
}

/** Shell results the server sends with the next message; removing one dismisses it. */
export const ComposerPendingShellCommands = memo(function ComposerPendingShellCommands(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<UserShellItem>;
  readonly canDismiss: boolean;
}) {
  const gt = useGT();
  const actions = useUserShellCommandActions();
  return (
    <div
      role="group"
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
      aria-label={gt("Shell results for your next message")}
    >
      {props.items.map((item) => (
        <ContextChip key={item.id} kind="terminal">
          <TerminalIcon />
          <Tooltip>
            <TooltipTrigger render={<ContextChipLabel className="max-w-72" />}>
              {item.input}
            </TooltipTrigger>
            <TooltipPopup side="top">{shellResultTooltip(item, gt)}</TooltipPopup>
          </Tooltip>
          {props.canDismiss ? (
            <ContextChipAction
              aria-label={gt("Leave out {command}", { command: item.input })}
              onClick={() =>
                void actions.setDelivery(
                  { environmentId: props.environmentId, threadId: item.threadId, itemId: item.id },
                  "dismissed",
                )
              }
            >
              <XIcon />
            </ContextChipAction>
          ) : null}
        </ContextChip>
      ))}
    </div>
  );
});
