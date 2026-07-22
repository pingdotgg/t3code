import { EventId, type OrchestrationThreadActivity, type ThreadGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadGoal } from "./threadGoal.ts";

const goal: ThreadGoal = {
  objective: "Finish the reconnect work",
  status: "active",
  tokenBudget: 20_000,
  tokensUsed: 1_250,
  timeUsedSeconds: 90,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:01:00.000Z",
};

function activity(
  kind: "goal.updated" | "goal.cleared",
  payload: unknown,
  sequence: number,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`goal-${sequence}`),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    sequence,
    createdAt: "2026-07-22T00:01:00.000Z",
  };
}

describe("deriveThreadGoal", () => {
  it("returns the latest provider-confirmed goal", () => {
    expect(deriveThreadGoal([activity("goal.updated", { goal }, 1)])).toEqual(goal);
  });

  it("returns no goal after a clear event", () => {
    expect(
      deriveThreadGoal([activity("goal.updated", { goal }, 1), activity("goal.cleared", {}, 2)]),
    ).toBeNull();
  });

  it("falls back to the latest valid goal when a newer update is malformed", () => {
    expect(
      deriveThreadGoal([
        activity("goal.updated", { goal }, 1),
        activity("goal.updated", { goal: { ...goal, status: "unknown" } }, 2),
      ]),
    ).toEqual(goal);
  });
});
