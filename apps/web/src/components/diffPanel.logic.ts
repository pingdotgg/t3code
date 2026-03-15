import type { TurnDiffSummary } from "../types";

interface CheckpointDiffAvailabilityInput {
  selectedTurn: TurnDiffSummary | undefined;
}

export function getUnavailableCheckpointDiffMessage({
  selectedTurn,
}: CheckpointDiffAvailabilityInput): string | null {
  if (!selectedTurn) {
    return null;
  }

  const checkpointMissing = selectedTurn.status === "missing" || !selectedTurn.checkpointRef;
  if (!checkpointMissing) {
    return null;
  }

  if (selectedTurn.status === "missing") {
    return "Checkpoint is marked as missing and cannot be restored.";
  }

  return "Checkpoint reference is unavailable for this turn.";
}
