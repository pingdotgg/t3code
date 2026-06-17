import { describe, expect, it } from "vite-plus/test";

import { removeAndRenumberTimelineItem } from "./orchestrationV2Timeline";

describe("removeAndRenumberTimelineItem", () => {
  it("closes the position gap before a streamed item is reinserted", () => {
    const remaining = removeAndRenumberTimelineItem(
      [
        { position: 0, sourceItemId: "first" },
        { position: 1, sourceItemId: "streaming" },
        { position: 2, sourceItemId: "last" },
      ],
      "streaming",
    );

    expect(remaining).toEqual([
      { position: 0, sourceItemId: "first" },
      { position: 1, sourceItemId: "last" },
    ]);
    expect(new Set(remaining.map((row) => row.position)).size).toBe(remaining.length);
  });
});
