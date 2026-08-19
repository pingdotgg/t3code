import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatGoalStatusMessage, type GoalChipAction } from "@t3tools/shared/composerTrigger";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

export function useThreadGoalActions() {
  const pauseThreadGoal = useAtomCommand(threadEnvironment.pauseGoal, { reportFailure: false });
  const resumeThreadGoal = useAtomCommand(threadEnvironment.resumeGoal, { reportFailure: false });
  const clearThreadGoal = useAtomCommand(threadEnvironment.clearGoal, { reportFailure: false });

  const runGoalAction = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly action: GoalChipAction;
    }) => {
      if (input.action === "clear") {
        // Deleting also stops any active run, so it needs an explicit confirm.
        // Pause/resume stay instant.
        const confirmed = await requestConfirmDialog(
          "Delete this Objective?\nAny active run on this Thread will be stopped.",
          { variant: "destructive" },
        );
        if (confirmed !== true) {
          return;
        }
      }
      const run =
        input.action === "pause"
          ? pauseThreadGoal
          : input.action === "resume"
            ? resumeThreadGoal
            : clearThreadGoal;
      const result = await run({
        environmentId: input.environmentId,
        input: { threadId: input.threadId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to update the Objective",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [clearThreadGoal, pauseThreadGoal, resumeThreadGoal],
  );

  const showGoalStatus = useCallback(
    (goal: { readonly status: string; readonly objective: string } | null | undefined) => {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Objective",
          description: formatGoalStatusMessage(goal ?? null),
        }),
      );
    },
    [],
  );

  return { runGoalAction, showGoalStatus };
}
