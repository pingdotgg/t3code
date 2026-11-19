import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";

/** A fresh-session schedule run starts a side conversation; the thread's own one continues past it. */
export function isScheduledFreshRun(
  run: Pick<OrchestrationV2Run, "freshContext" | "userMessageId">,
  turnItems: OrchestrationV2ThreadProjection["turnItems"],
): boolean {
  // A compacted thread's command read loads these prompts for every fresh-context run.
  return (
    run.freshContext === true &&
    turnItems.some(
      (item) =>
        item.type === "user_message" &&
        item.messageId === run.userMessageId &&
        item.scheduledTaskId !== undefined,
    )
  );
}

/** Ordinal of the latest started fresh-context run. Runs before it never reach a provider again. */
export function contextBoundaryOrdinal(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
): number {
  let boundary = 0;
  for (const run of projection.runs) {
    if (
      run.freshContext === true &&
      run.status !== "queued" &&
      !cancelledBeforeStart(run) &&
      run.ordinal > boundary &&
      !isScheduledFreshRun(run, projection.turnItems)
    ) {
      boundary = run.ordinal;
    }
  }
  return boundary;
}
