import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { BellIcon, BellRingIcon } from "lucide-react";
import { useState } from "react";

import { teamEnvironment, useTeamThreadFollowState } from "~/state/team";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useTeamThreadFollowToggle } from "./useTeamThreadFollowToggle";

export function TeamThreadFollowButton({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const { canFollow, isFollowing } = useTeamThreadFollowState(environmentId, threadId);
  const canFollowPermission = useAtomValue(
    teamEnvironment.followThread.permissionAtom(environmentId),
  );
  const canUnfollowPermission = useAtomValue(
    teamEnvironment.unfollowThread.permissionAtom(environmentId),
  );
  const { setFollowing } = useTeamThreadFollowToggle();
  const [pending, setPending] = useState(false);

  if (!canFollow) return null;

  const canToggle = isFollowing ? canUnfollowPermission : canFollowPermission;
  const label = isFollowing
    ? gt("Following", { $context: "state, subscribed to thread notifications" })
    : gt("Follow", { $context: "verb, subscribe to thread notifications" });
  const ariaLabel = isFollowing
    ? gt("Unfollow thread notifications")
    : gt("Follow thread notifications");

  const handleClick = async () => {
    if (pending || !canToggle) return;
    setPending(true);
    await setFollowing({
      environmentId,
      threadId,
      follow: !isFollowing,
    }).catch(() => false);
    setPending(false);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant={isFollowing ? "secondary" : "ghost"}
            data-testid="team-thread-follow-button"
            aria-pressed={isFollowing}
            aria-label={ariaLabel}
            disabled={pending || !canToggle}
            onClick={() => void handleClick()}
            className="shrink-0"
          />
        }
      >
        {isFollowing ? (
          <BellRingIcon aria-hidden className="size-3.5" />
        ) : (
          <BellIcon aria-hidden className="size-3.5" />
        )}
        <span className="hidden sm:inline">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {isFollowing ? (
          <T>Following thread notifications. Click to unfollow.</T>
        ) : (
          <T>Follow this thread to receive notifications on updates.</T>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
