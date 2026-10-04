import { describe, expect, it } from "vite-plus/test";

import { resolveThreadFeedFixedItemSize } from "./thread-feed-item-size";

describe("resolveThreadFeedFixedItemSize", () => {
  it("leaves activity groups to native measurement", () => {
    expect(resolveThreadFeedFixedItemSize("activity-group")).toBeUndefined();
  });

  it("measures the unread divider, whose height follows the text size", () => {
    expect(resolveThreadFeedFixedItemSize("unread-boundary")).toBeUndefined();
  });

  it("keeps fixed timeline chrome on the premeasured path", () => {
    expect(resolveThreadFeedFixedItemSize("run-fold")).toBe(42);
    expect(resolveThreadFeedFixedItemSize("work-toggle")).toBe(28);
  });
});
