import { type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function subagentGroupTiming(
  agents: ReadonlyArray<{
    status: OrchestrationV2TurnItem["status"];
    startedAt: DateTime.Utc | null;
    completedAt: DateTime.Utc | null;
  }>,
) {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let endUnknown = false;
  for (const agent of agents) {
    if (agent.startedAt) {
      const ms = DateTime.toEpochMillis(agent.startedAt);
      startMs = startMs === null ? ms : Math.min(startMs, ms);
    }
    if (agent.completedAt) {
      const ms = DateTime.toEpochMillis(agent.completedAt);
      endMs = endMs === null ? ms : Math.max(endMs, ms);
    } else {
      endUnknown = true;
    }
  }
  const live = agents.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    status: live ? ("running" as const) : ("completed" as const),
    startedAt: startMs === null ? null : new Date(startMs).toISOString(),
    completedAt: live || endUnknown || endMs === null ? null : new Date(endMs).toISOString(),
  };
}
