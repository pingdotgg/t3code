import { describe, expect, it } from "vite-plus/test";

import {
  removeAndRenumberTimelineItem,
  upsertTimelineItemAtStablePosition,
} from "./orchestrationV2Timeline";

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

describe("upsertTimelineItemAtStablePosition", () => {
  it("replaces a streaming item without moving it behind newer items", () => {
    const updated = upsertTimelineItemAtStablePosition(
      [
        { position: 0, sourceItemId: "reasoning", text: "partial" },
        { position: 1, sourceItemId: "subagent", text: "running" },
      ],
      { position: 2, sourceItemId: "reasoning", text: "completed" },
    );

    expect(updated).toEqual([
      { position: 0, sourceItemId: "reasoning", text: "completed" },
      { position: 1, sourceItemId: "subagent", text: "running" },
    ]);
  });

  it("appends a genuinely new item at the next position", () => {
    const updated = upsertTimelineItemAtStablePosition(
      [{ position: 0, sourceItemId: "reasoning" }],
      { position: 99, sourceItemId: "assistant" },
    );

    expect(updated).toEqual([
      { position: 0, sourceItemId: "reasoning" },
      { position: 1, sourceItemId: "assistant" },
    ]);
  });
});
