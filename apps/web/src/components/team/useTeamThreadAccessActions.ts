import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TeamViewId, ThreadId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function useTeamThreadAccessActions() {
  const runSetThreadView = useAtomCommand(teamEnvironment.setThreadView, {
    reportFailure: false,
  });
  const runSetThreadLocked = useAtomCommand(teamEnvironment.setThreadLocked, {
    reportFailure: false,
  });

  const setThreadView = async (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly viewId: TeamViewId;
  }): Promise<boolean> => {
    const result = await runSetThreadView({
      environmentId: input.environmentId,
      input: { threadId: input.threadId, viewId: input.viewId },
    });
    if (result._tag === "Success") {
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to move thread to view")),
          description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
        }),
      );
    }
    return false;
  };

  const setThreadLocked = async (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly locked: boolean;
  }): Promise<boolean> => {
    const result = await runSetThreadLocked({
      environmentId: input.environmentId,
      input: { threadId: input.threadId, locked: input.locked },
    });
    if (result._tag === "Success") {
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: input.locked ? m(msg("Failed to lock thread")) : m(msg("Failed to unlock thread")),
          description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
        }),
      );
    }
    return false;
  };

  return { setThreadView, setThreadLocked };
}
