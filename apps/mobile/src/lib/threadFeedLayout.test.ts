import { describe, expect, it } from "vite-plus/test";

import {
  isThreadFeedNearEnd,
  resolveThreadFeedBottomInset,
  threadFeedDistanceFromEnd,
} from "./threadFeedLayout";

describe("thread feed layout", () => {
  it("accounts for the bottom inset when measuring distance from the end", () => {
    const metrics = {
      contentHeight: 900,
      viewportHeight: 600,
      offsetY: 380,
      bottomInset: 100,
    };

    expect(threadFeedDistanceFromEnd(metrics)).toBe(20);
    expect(isThreadFeedNearEnd(metrics, 50)).toBe(true);
    expect(isThreadFeedNearEnd(metrics, 10)).toBe(false);
  });

  it("does not double count chrome already included in the measured composer overlay", () => {
    expect(
      resolveThreadFeedBottomInset({
        estimatedOverlayHeight: 162,
        measuredOverlayHeight: 182,
        gap: 8,
      }),
    ).toBe(190);
  });
});
