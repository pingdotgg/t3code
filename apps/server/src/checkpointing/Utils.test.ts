import { describe, expect, it } from "vitest";

import { latestCapturedCheckpointTurnCount } from "./Utils.ts";

describe("latestCapturedCheckpointTurnCount", () => {
  it("ignores missing and speculative checkpoints", () => {
    expect(
      latestCapturedCheckpointTurnCount([
        { checkpointTurnCount: 1, status: "ready" },
        { checkpointTurnCount: 2, status: "missing" },
        { checkpointTurnCount: 3, status: "error" },
        { checkpointTurnCount: 4, status: "speculative" },
      ]),
    ).toBe(3);
  });

  it("falls back to the pre-turn baseline count when only placeholders exist", () => {
    expect(
      latestCapturedCheckpointTurnCount([
        { checkpointTurnCount: 1, status: "missing" },
        { checkpointTurnCount: 2, status: "speculative" },
      ]),
    ).toBe(0);
  });
});
