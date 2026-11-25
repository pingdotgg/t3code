import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { LockIcon } from "lucide-react";

import { useTeamThreadAccessState } from "~/state/team";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function TeamThreadStatusBadges({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const access = useTeamThreadAccessState(environmentId, threadId);

  if (!access.isTeamThread) return null;

  const showViewBadge = access.view !== null && !access.view.isDefault;
  if (!access.locked && !showViewBadge) return null;

  return (
    <>
      {access.locked ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-testid="team-thread-locked-indicator"
                role="img"
                aria-label={gt("Locked thread")}
                className="inline-flex shrink-0 items-center text-warning-foreground"
              />
            }
          >
            <LockIcon aria-hidden className="size-3 shrink-0" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <T>Thread is locked (owners and admins only)</T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {showViewBadge && access.view ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="outline" size="sm" data-testid="team-thread-view-badge">
                <span className="max-w-20 truncate">{access.view.name}</span>
              </Badge>
            }
          />
          <TooltipPopup side="top">
            <T>
              Team view: <Var>{access.view.name}</Var>
            </T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
