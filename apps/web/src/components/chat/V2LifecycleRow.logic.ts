import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type SubagentDisplayStatus =
  | OrchestrationV2TurnItem["status"]
  | "preparing"
  | "starting"
  | "queued";

export function resolveSubagentDisplayStatus(
  status: OrchestrationV2TurnItem["status"],
  child: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status"> | null | undefined,
): SubagentDisplayStatus {
  if (!child || !isOrchestrationV2WorkActive(status)) return status;
  const childStatus = child.activityRunStatus ?? (child.status === "queued" ? "queued" : null);
  if (childStatus === "preparing" || childStatus === "starting" || childStatus === "queued") {
    return childStatus;
  }
  return status;
}

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
