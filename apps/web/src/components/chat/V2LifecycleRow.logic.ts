import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const ACTIVE_SUBAGENT_STATUSES = new Set<OrchestrationV2Subagent["status"]>([
  "pending",
  "running",
  "waiting",
]);

/** Claude can reuse resumed agent ids. Active agents supersede outcomes; settled agents must start after notification. */
export function subagentResumedSince(
  agent: Pick<OrchestrationV2Subagent, "status" | "startedAt">,
  notifiedAt: string,
): boolean {
  if (ACTIVE_SUBAGENT_STATUSES.has(agent.status)) return true;
  if (agent.startedAt === null) return false;
  const notifiedAtMillis = Date.parse(notifiedAt);
  return (
    !Number.isNaN(notifiedAtMillis) && DateTime.toEpochMillis(agent.startedAt) > notifiedAtMillis
  );
}
