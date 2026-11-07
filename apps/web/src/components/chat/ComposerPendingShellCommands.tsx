import type { UserShellItem } from "@t3tools/client-runtime/state/user-shell-commands";
import type { EnvironmentId } from "@t3tools/contracts";
import { TerminalIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useUserShellCommandActions } from "./userShellCommands";

function shellResultSummary(item: UserShellItem): string {
  if (item.status === "running") return "Still running. Its output so far";
  if (item.userShell.stoppedByUser) return "Stopped. Its output";
  if (item.exitCode !== undefined) return `Exited with code ${item.exitCode}. Its output`;
  return "Its output";
}

/** Shell results the server sends with the next message; removing one dismisses it. */
export const ComposerPendingShellCommands = memo(function ComposerPendingShellCommands(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<UserShellItem>;
  readonly canDismiss: boolean;
}) {
  const actions = useUserShellCommandActions();
  return (
    <div
      role="group"
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
      aria-label="Shell results for your next message"
    >
      {props.items.map((item) => (
        <ContextChip key={item.id} kind="terminal">
          <TerminalIcon />
          <Tooltip>
            <TooltipTrigger render={<ContextChipLabel className="max-w-72" />}>
              {item.input}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {`${shellResultSummary(item)} goes with your next message.`}
            </TooltipPopup>
          </Tooltip>
          {props.canDismiss ? (
            <ContextChipAction
              aria-label={`Leave out ${item.input}`}
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
