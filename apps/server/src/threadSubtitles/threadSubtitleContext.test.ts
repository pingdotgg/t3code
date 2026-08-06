import { describe, expect, it } from "vite-plus/test";

import { formatThreadSubtitleContext } from "./threadSubtitleContext.ts";

describe("formatThreadSubtitleContext", () => {
  it("orders recent messages and activity while dropping streaming snapshots", () => {
    const context = formatThreadSubtitleContext({
      messages: [
        {
          id: "message-user" as never,
          role: "user",
          text: "Add generated subtitles",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-06T08:00:00.000Z",
          updatedAt: "2026-08-06T08:00:00.000Z",
        },
        {
          id: "message-stream" as never,
          role: "assistant",
          text: "partial output",
          turnId: null,
          streaming: true,
          createdAt: "2026-08-06T08:00:01.000Z",
          updatedAt: "2026-08-06T08:00:01.000Z",
        },
      ],
      activities: [
        {
          id: "activity-1" as never,
          tone: "tool",
          kind: "tool.completed",
          summary: "Updated subtitle projection",
          payload: {},
          turnId: null,
          createdAt: "2026-08-06T08:00:02.000Z",
        },
      ],
    });

    expect(context).toBe(
      "USER: Add generated subtitles\nACTIVITY: tool.completed · Updated subtitle projection",
    );
    expect(context).not.toContain("partial output");
  });
});
