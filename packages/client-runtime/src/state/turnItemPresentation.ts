import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Run,
} from "@t3tools/contracts";

import type { ThreadStructureTurnItem } from "./models.ts";

const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

type TurnItemOf<T extends ThreadStructureTurnItem["type"]> = Extract<
  ThreadStructureTurnItem,
  { readonly type: T }
>;

/** Only the fields the check reads, so partial items (such as Activity's) fit too. */
type WorkspacePreparationCandidate =
  | Pick<TurnItemOf<"command_execution">, "type" | "input">
  | Pick<TurnItemOf<"error">, "type" | "status" | "failure">
  | { readonly type: Exclude<ThreadStructureTurnItem["type"], "command_execution" | "error"> };

export function turnItemIsWorkspacePreparation(item: WorkspacePreparationCandidate): boolean {
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
  const failedRuns = new Set(
    runs.flatMap((run) =>
      run.status === "failed" && run.workspacePreparation !== undefined ? [run.id] : [],
    ),
  );
  const retryable = new Set<OrchestrationV2Run["id"]>();
  if (failedRuns.size === 0) return retryable;
  for (const item of items) {
    if (
      item.type === "error" &&
      item.status === "failed" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE &&
      item.runId !== null &&
      failedRuns.has(item.runId)
    )
      retryable.add(item.runId);
  }
  return retryable;
}
