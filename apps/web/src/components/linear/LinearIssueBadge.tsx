import type { LinearIssueLink, LinearWorkflowStateType } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { LinearIcon } from "../Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Color the pill by workflow-state category so "Done" reads as complete. */
function stateColorClass(stateType: LinearWorkflowStateType | undefined): string {
  switch (stateType) {
    case "completed":
      return "text-violet-600 dark:text-violet-400";
    case "started":
      return "text-amber-600 dark:text-amber-400";
    case "canceled":
      return "text-muted-foreground/70 line-through";
    default:
      return "text-muted-foreground";
  }
}

/**
 * Compact pill linking a thread to its Linear issue. Reflects the issue's live
 * workflow state (advances In Progress → In Review → Done as the reactor writes
 * status back).
 */
export function LinearIssueBadge({
  issue,
  className,
}: {
  issue: LinearIssueLink;
  className?: string;
}) {
  const stateLabel = issue.stateName ?? "Linear";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-sm px-1 font-mono text-[10px] leading-4 transition-colors hover:bg-accent",
              stateColorClass(issue.stateType),
              className,
            )}
            aria-label={`Linear ${issue.identifier} — ${stateLabel}`}
          >
            <LinearIcon className="size-2.5" />
            {issue.identifier}
          </a>
        }
      />
      <TooltipPopup side="top">
        {issue.identifier} · {stateLabel}
      </TooltipPopup>
    </Tooltip>
  );
}
