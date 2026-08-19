import type { OrchestrationThreadGoalStatus } from "@t3tools/contracts";
import { formatGoalStatusLabel } from "@t3tools/shared/composerTrigger";
import { useEffect, useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useThreadShells } from "../state/entities";

const TOAST_ON_STATUS = {
  complete: "success",
  blocked: "error",
  usageLimited: "warning",
} as const satisfies Partial<
  Record<OrchestrationThreadGoalStatus, "success" | "error" | "warning">
>;

type ToastableGoalStatus = keyof typeof TOAST_ON_STATUS;

function isToastableGoalStatus(status: string): status is ToastableGoalStatus {
  return status in TOAST_ON_STATUS;
}

/**
 * Watches every Thread shell's Goal and raises a toast when one settles into a
 * state the user should hear about (complete, blocked, usage-limited). Mounted
 * once at the app root so background Threads notify even when not open.
 * User-driven transitions (pause/resume/clear) already happen in front of the
 * user, so they stay silent.
 */
export function GoalStatusToastCoordinator() {
  const threads = useThreadShells();
  const seenStatusesRef = useRef<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const previousStatuses = seenStatusesRef.current;
    const nextStatuses = new Map<string, string>();
    for (const thread of threads) {
      const goal = thread.goal;
      if (goal == null) {
        continue;
      }
      const key = `${thread.environmentId}:${thread.id}`;
      nextStatuses.set(key, goal.status);
      const previousStatus = previousStatuses.get(key);
      if (
        previousStatus === undefined ||
        previousStatus === goal.status ||
        !isToastableGoalStatus(goal.status)
      ) {
        continue;
      }
      toastManager.add(
        stackedThreadToast({
          type: TOAST_ON_STATUS[goal.status],
          title: `Objective ${formatGoalStatusLabel(goal.status).toLowerCase()}`,
          description: goal.objectivePreview,
        }),
      );
    }
    seenStatusesRef.current = nextStatuses;
  }, [threads]);

  return null;
}
