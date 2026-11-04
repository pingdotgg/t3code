import type { LinearIssue } from "@t3tools/contracts";
import { blockedByTitle, isLinearIssueBlocked } from "@t3tools/shared/linearBlocked";
import { BanIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Shown only while an open blocker remains; the tooltip names the blockers. */
export function LinearBlockedBadge({ issue }: { issue: Pick<LinearIssue, "blockedBy" | "state"> }) {
  if (!isLinearIssueBlocked(issue)) return null;
  const title = blockedByTitle(issue);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={title}
            className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-medium text-warning-foreground"
          />
        }
      >
        <BanIcon aria-hidden className="size-3" />
        Blocked
      </TooltipTrigger>
      <TooltipPopup side="top">{title}</TooltipPopup>
    </Tooltip>
  );
}
