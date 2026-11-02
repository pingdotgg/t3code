import type {
  ModelSelection,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

/**
 * The model or effort change a new run brings, measured from the latest run whose message is in
 * the timeline, so consecutive dividers always chain. Callers skip starts with a context handoff;
 * the handoff item already shows those.
 */
export function modelSwitchSince(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  to: ModelSelection,
): Pick<Extract<OrchestrationV2TurnItem, { type: "user_message" }>, "modelSwitch"> {
  const shown = new Set(
    projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.messageId] : [])),
  );
  let previous: OrchestrationV2ThreadProjection["runs"][number] | undefined;
  for (const run of projection.runs) {
    if (run.status === "rolled_back" || !shown.has(run.userMessageId)) continue;
    if (previous === undefined || run.ordinal > previous.ordinal) previous = run;
  }
  return previous === undefined || modelSelectionsEqual(previous.modelSelection, to)
    ? {}
    : { modelSwitch: { from: previous.modelSelection, to } };
}
