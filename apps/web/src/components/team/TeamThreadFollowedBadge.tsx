import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { BellIcon } from "lucide-react";

import { useTeamThreadFollowState } from "~/state/team";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function TeamThreadFollowedBadge({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const { canFollow, isFollowing } = useTeamThreadFollowState(environmentId, threadId);

  if (!canFollow || !isFollowing) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-testid="team-thread-followed-badge"
            role="img"
            aria-label={gt("Following thread")}
            className="inline-flex shrink-0 items-center text-muted-foreground/75"
          />
        }
      >
        <BellIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Following thread notifications</T>
      </TooltipPopup>
    </Tooltip>
  );
}
