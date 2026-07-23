import type { OrchestrationThreadActivity } from "@t3tools/contracts";

const TURN_LIFECYCLE_INSIGHT_KINDS: ReadonlySet<string> = new Set([
  "insights.turn.started",
  "insights.turn.completed",
  "insights.turn.aborted",
]);

export function isTurnLifecycleInsightActivity(activity: OrchestrationThreadActivity): boolean {
  return TURN_LIFECYCLE_INSIGHT_KINDS.has(activity.kind);
}
