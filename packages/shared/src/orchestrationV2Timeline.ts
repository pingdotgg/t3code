import type {
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

type TimelineRun = Pick<OrchestrationV2Run, "id" | "status">;
type TimelineRunAttempt = Pick<OrchestrationV2RunAttempt, "runId" | "rootNodeId" | "status">;
type TimelineTurnItem = Pick<OrchestrationV2TurnItem, "type" | "runId" | "nodeId">;

export function isOrchestrationV2SupersededInterrupt(input: {
  readonly item: TimelineTurnItem;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
}): boolean {
  const { item } = input;
  if (item.type !== "run_interrupt_result" || item.runId === null || item.nodeId === null) {
    return false;
  }

  return input.attempts.some(
    (attempt) =>
      attempt.runId === item.runId &&
      attempt.rootNodeId === item.nodeId &&
      attempt.status === "superseded",
  );
}

export function isOrchestrationV2TurnItemVisible(input: {
  readonly item: TimelineTurnItem;
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
}): boolean {
  const { item } = input;
  if (
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "rolled_back")
  ) {
    return false;
  }

  return !isOrchestrationV2SupersededInterrupt({ item, attempts: input.attempts });
}
