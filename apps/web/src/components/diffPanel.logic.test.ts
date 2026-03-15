import { describe, expect, it } from "vitest";
import { MessageId, TurnId } from "@t3tools/contracts";

import { getUnavailableCheckpointDiffMessage } from "./diffPanel.logic";
import type { TurnDiffSummary } from "../types";

const turnId = TurnId.makeUnsafe("turn-1");

function makeTurnSummary(overrides: Partial<TurnDiffSummary> = {}): TurnDiffSummary {
  return {
    turnId,
    completedAt: new Date().toISOString(),
    status: "ready",
    files: [],
    checkpointRef: "checkpoint:1" as never,
    assistantMessageId: MessageId.makeUnsafe("assistant:1"),
    checkpointTurnCount: 1,
    ...overrides,
  };
}

describe("getUnavailableCheckpointDiffMessage", () => {
  it("returns an unavailable message for missing checkpoints", () => {
    const message = getUnavailableCheckpointDiffMessage({
      selectedTurn: makeTurnSummary({ status: "missing", checkpointRef: undefined }),
    });

    expect(message).toBe("Checkpoint is marked as missing and cannot be restored.");
  });

  it("returns an unavailable message when checkpoint ref is missing", () => {
    const message = getUnavailableCheckpointDiffMessage({
      selectedTurn: makeTurnSummary({ status: "ready", checkpointRef: undefined }),
    });

    expect(message).toBe("Checkpoint reference is unavailable for this turn.");
  });

  it("does not block ready checkpoints with valid refs", () => {
    const message = getUnavailableCheckpointDiffMessage({
      selectedTurn: makeTurnSummary(),
    });

    expect(message).toBeNull();
  });
});
