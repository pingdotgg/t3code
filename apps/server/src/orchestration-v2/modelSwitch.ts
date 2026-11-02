import {
  isCompactionCommandMessage,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";

/**
 * The model or effort change a new run brings, measured from the latest run the timeline shows
 * through its message or its handoff row, so consecutive dividers always chain. `baseline` stands
 * in when there is none, such as a fork's source run. Callers skip starts with a context handoff;
 * the handoff item already shows those.
 */
export function modelSwitchSince(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  to: ModelSelection,
  baseline?: ModelSelection,
): Pick<Extract<OrchestrationV2TurnItem, { type: "user_message" }>, "modelSwitch"> {
  // Clients hide pending queued messages, fold async answers into their question, and replace
  // `/compact` with a compaction row.
  const shown = new Set(
    projection.turnItems.flatMap((item) =>
      item.type === "user_message" &&
      !(item.inputIntent === "queued_turn" && item.status === "pending") &&
      !item.messageId.startsWith("async-answer:") &&
      !isCompactionCommandMessage({ role: "user", ...item })
        ? [item.messageId]
        : [],
    ),
  );
  let previous: OrchestrationV2ThreadProjection["runs"][number] | undefined;
  for (const run of projection.runs) {
    if (run.status === "rolled_back" || run.status === "queued") continue;
    // A wake shows as a notification, but its context handoff row still shows the swap.
    if (!shown.has(run.userMessageId) && run.contextHandoffId === null) continue;
    if (previous === undefined || runRanAfter(run, previous)) previous = run;
  }
  const from = previous?.modelSelection ?? baseline;
  return from === undefined || modelSelectionsEqual(from, to) ? {} : { modelSwitch: { from, to } };
}
