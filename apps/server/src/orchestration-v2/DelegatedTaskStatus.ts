import type { OrchestrationV2Subagent } from "@t3tools/contracts";

export const terminalDelegatedTaskStatuses = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export function isTerminalDelegatedTaskStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return terminalDelegatedTaskStatuses.some((terminal) => terminal === status);
}
