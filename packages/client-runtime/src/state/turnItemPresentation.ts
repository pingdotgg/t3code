import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import type { ThreadStructureTurnItem } from "./models.ts";

const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

export function turnItemIsWorkspacePreparation(item: OrchestrationV2TurnItem): boolean {
  return (
    (item.type === "command_execution" && item.input === WORKSPACE_PREPARATION_INPUT) ||
    (item.type === "error" &&
      item.status === "cancelled" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE)
  );
}

export function workspacePreparationRetryRunIds(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "workspacePreparation">>,
  items: ReadonlyArray<ThreadStructureTurnItem>,
): ReadonlySet<OrchestrationV2Run["id"]> {
  const endedRuns = new Map(
    runs.flatMap((run) =>
      (run.status === "failed" || run.status === "interrupted") &&
      run.workspacePreparation !== undefined
        ? [[run.id, run.status] as const]
        : [],
    ),
  );
  const retryable = new Set<OrchestrationV2Run["id"]>();
  if (endedRuns.size === 0) return retryable;
  for (const item of items) {
    if (item.runId === null) continue;
    const status = endedRuns.get(item.runId);
    if (
      (status === "failed" &&
        item.type === "error" &&
        item.status === "failed" &&
        item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE) ||
      // A stop during setup leaves the preparation itself interrupted.
      (status === "interrupted" &&
        item.type === "command_execution" &&
        item.input === WORKSPACE_PREPARATION_INPUT &&
        item.status === "interrupted")
    )
      retryable.add(item.runId);
  }
  return retryable;
}
