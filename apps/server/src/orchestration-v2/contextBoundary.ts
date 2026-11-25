import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";

/** A fresh-session schedule run starts a side conversation; the thread's own one continues past it. */
export function isScheduledFreshRun(
  run: Pick<OrchestrationV2Run, "id" | "freshContext" | "userMessageId">,
  turnItems: OrchestrationV2ThreadProjection["turnItems"],
): boolean {
  if (run.freshContext !== true) return false;
  // A steering restart replaces userMessageId; the run's first prompt still records its origin.
  // A compacted thread's command read loads these prompts for every fresh-context run.
  let prompt: OrchestrationV2ThreadProjection["turnItems"][number] | undefined;
  for (const item of turnItems) {
    if (item.type !== "user_message") continue;
    if (item.runId === run.id) {
      if (prompt?.runId !== run.id || item.ordinal < prompt.ordinal) prompt = item;
    } else if (prompt === undefined && item.messageId === run.userMessageId) {
      prompt = item;
    }
  }
  return prompt?.type === "user_message" && prompt.scheduledTaskId !== undefined;
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

/** Rows of runs from the latest context boundary on; all rows when nothing was cleared. */
export function turnItemsSinceContextBoundary(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
): { readonly boundary: number; readonly turnItems: OrchestrationV2ThreadProjection["turnItems"] } {
  const boundary = contextBoundaryOrdinal(projection);
  if (boundary === 0) return { boundary, turnItems: projection.turnItems };
  const kept = new Set(
    projection.runs.filter((run) => run.ordinal >= boundary).map((run) => run.id),
  );
  return {
    boundary,
    turnItems: projection.turnItems.filter((item) => item.runId !== null && kept.has(item.runId)),
  };
}
