import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { readTeamThreadLocation, teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function useTeamThreadFollowToggle() {
  const followThread = useAtomCommand(teamEnvironment.followThread, {
    reportFailure: false,
  });
  const unfollowThread = useAtomCommand(teamEnvironment.unfollowThread, {
    reportFailure: false,
  });

  const setFollowing = async (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly follow: boolean;
  }): Promise<boolean> => {
    const targetTeamEnvironmentId = readTeamThreadLocation(
      input.environmentId,
      input.threadId,
    )?.teamEnvironmentId;
    if (targetTeamEnvironmentId === undefined) return false;
    const result = input.follow
      ? await followThread({
          environmentId: targetTeamEnvironmentId,
          input: { threadId: input.threadId },
        })
      : await unfollowThread({
          environmentId: targetTeamEnvironmentId,
          input: { threadId: input.threadId },
        });
    if (result._tag === "Success") {
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: input.follow
            ? m(msg("Failed to follow thread"))
            : m(msg("Failed to unfollow thread")),
          description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
        }),
      );
    }
    return false;
  };

  return { setFollowing };
}
