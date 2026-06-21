import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  CheckpointRefUnavailableError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread-1");

it("derives checkpoint messages from structured context", () => {
  const range = new CheckpointTurnRangeUnavailableError({
    operation: "CheckpointDiffQuery.getTurnDiff",
    threadId,
    requestedTurnCount: 4,
    availableTurnCount: 2,
  });
  const checkpoint = new CheckpointRefUnavailableError({
    operation: "CheckpointDiffQuery.getTurnDiff",
    threadId,
    turnCount: 2,
    checkpoint: "to",
  });
  const workspace = new CheckpointWorkspacePathMissingError({
    operation: "CheckpointDiffQuery.getFullThreadDiff",
    threadId,
  });

  expect(range.message).toBe(
    "Checkpoint unavailable for thread thread-1 turn 4: Turn diff range exceeds current turn count: requested 4, current 2.",
  );
  expect(checkpoint.message).toBe(
    "Checkpoint unavailable for thread thread-1 turn 2: Checkpoint ref is unavailable for turn 2.",
  );
  expect(workspace.message).toBe(
    "Checkpoint invariant violation in CheckpointDiffQuery.getFullThreadDiff: Workspace path missing for thread 'thread-1' when computing full thread diff.",
  );
});
