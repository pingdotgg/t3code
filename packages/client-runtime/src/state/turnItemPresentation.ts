import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

/** Workspace setup is client bookkeeping; preparation failures have their own error item. */
export function turnItemIsWorkspacePreparation(item: OrchestrationV2TurnItem): boolean {
  return item.type === "command_execution" && item.input === WORKSPACE_PREPARATION_INPUT;
}
