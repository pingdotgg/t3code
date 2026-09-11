import type { OrchestrationCheckpointSummary } from "@t3tools/contracts";

type Checkpoint = Pick<OrchestrationCheckpointSummary, "checkpointTurnCount" | "status">;

export function canLoadTurnDiff(
  selected: Checkpoint | undefined,
  checkpoints: readonly Checkpoint[],
): boolean {
  if (selected?.status !== "ready") return false;
  return (
    selected.checkpointTurnCount <= 1 ||
    checkpoints.some(
      (checkpoint) =>
        checkpoint.checkpointTurnCount === selected.checkpointTurnCount - 1 &&
        checkpoint.status === "ready",
    )
  );
}
