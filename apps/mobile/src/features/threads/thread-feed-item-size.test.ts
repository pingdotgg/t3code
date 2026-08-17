import { describe, expect, it } from "vite-plus/test";

import { resolveThreadFeedFixedItemSize } from "./thread-feed-item-size";

describe("resolveThreadFeedFixedItemSize", () => {
  it("leaves activity groups to native measurement", () => {
    expect(resolveThreadFeedFixedItemSize("activity-group", 16)).toBeUndefined();
  });

  it("keeps fixed timeline chrome on the premeasured path", () => {
    expect(resolveThreadFeedFixedItemSize("run-fold", 16)).toBe(56);
    expect(resolveThreadFeedFixedItemSize("work-toggle", 16)).toBe(36);
    expect(resolveThreadFeedFixedItemSize("working", 16)).toBeGreaterThan(24);
  });
});
