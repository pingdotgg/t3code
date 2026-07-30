import { describe, expect, it } from "vitest";

import { classifyThreadQueuePromotion } from "./ThreadExtensionService.ts";

describe("classifyThreadQueuePromotion", () => {
  const idleThread = {
    latestTurn: null,
    session: null,
    checkpoints: [],
  };

  it("promotes an idle thread", () => {
    expect(classifyThreadQueuePromotion(idleThread)).toBe("yes");
  });

  it("waits for provider and checkpoint settlement barriers", () => {
    expect(
      classifyThreadQueuePromotion({
        ...idleThread,
        session: { status: "running", activeTurnId: "turn-1" },
      }),
    ).toBe("wait");
    expect(
      classifyThreadQueuePromotion({
        ...idleThread,
        latestTurn: { turnId: "turn-1", state: "completed" },
      }),
    ).toBe("wait");
    expect(
      classifyThreadQueuePromotion({
        ...idleThread,
        latestTurn: { turnId: "turn-1", state: "completed" },
        checkpoints: [{ turnId: "turn-1" }],
      }),
    ).toBe("yes");
  });

  it("pauses after interruption and provider failure", () => {
    expect(
      classifyThreadQueuePromotion({
        ...idleThread,
        latestTurn: { turnId: "turn-1", state: "interrupted" },
      }),
    ).toBe("interrupted");
    expect(
      classifyThreadQueuePromotion({
        ...idleThread,
        latestTurn: { turnId: "turn-1", state: "error" },
      }),
    ).toBe("provider-error");
  });
});
