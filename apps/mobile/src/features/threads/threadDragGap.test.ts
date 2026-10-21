import { describe, expect, it } from "vite-plus/test";
import { threadDragAction, threadOrderAfterMove } from "./threadOrder";

describe("drag action labels", () => {
  it("does not offer a parked-section reorder or snooze without a wake time", () => {
    expect(threadDragAction("settled", "settled")).toBeNull();
    expect(threadDragAction("active", "snoozed")).toBeNull();
    expect(
      threadOrderAfterMove(["a", "b"], "a", {
        section: "settled",
        targetId: null,
        placement: "before",
      }),
    ).toBeNull();
  });
});
