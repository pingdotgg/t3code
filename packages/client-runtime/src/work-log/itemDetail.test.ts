import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { turnItemOutputImages, turnItemOutputText } from "./itemDetail.ts";

const screenshot = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__t3-code__device_screenshot",
  input: { deviceId: "phone" },
  output: {
    content: [
      { type: "text", text: "Captured the home screen." },
      { type: "image", mimeType: "image/png" },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

describe("tool output images", () => {
  it("shows a screenshot as an image asset, not as text", () => {
    expect(turnItemOutputImages(screenshot)).toEqual([
      {
        _tag: "tool-output-image",
        threadId: screenshot.threadId,
        itemId: screenshot.id,
        index: 0,
      },
    ]);
    expect(turnItemOutputText(screenshot)).toBe("Captured the home screen.");
    expect(
      turnItemOutputText({ ...screenshot, output: { content: [screenshot.output.content[1]] } }),
    ).toBeNull();
  });

  it("keeps a placeholder for images it cannot show", () => {
    const output = { content: [{ type: "image", mimeType: "image/svg+xml" }] };
    expect(turnItemOutputImages({ ...screenshot, output })).toEqual([]);
    expect(turnItemOutputText({ ...screenshot, output })).toBe("[image]");
  });

  it("omits Claude Read's image placeholder when the file has a preview", () => {
    const output = {
      type: "image",
      file: { filePath: "/tmp/blk.png", type: "image/png", sizeBytes: 1024 },
    };
    const item = { ...screenshot, toolName: "Read", viewedImagePath: "/tmp/blk.png", output };

    expect(turnItemOutputImages(item)).toEqual([]);
    expect(turnItemOutputText(item)).toBeNull();
    expect(turnItemOutputText({ ...item, viewedImagePath: undefined })).toBe("[image]");
  });

  it("keeps accompanying text and literal image markers when the file has a preview", () => {
    const output = {
      content: [
        { type: "text", text: "Read /tmp/blk.png. Literal marker: [image]" },
        screenshot.output.content[1],
      ],
    };
    expect(turnItemOutputText({ ...screenshot, viewedImagePath: "/tmp/blk.png", output })).toBe(
      "Read /tmp/blk.png. Literal marker: [image]",
    );
  });

  it("keeps placeholders for unserved images in a list despite a file preview", () => {
    const blocks = [
      { type: "text", text: "Read /tmp/blk.png." },
      { type: "image", file: { type: "image/png", sizeBytes: 1024 } },
      screenshot.output.content[1],
      { type: "image", mimeType: "image/svg+xml" },
    ];
    for (const output of [blocks, { content: blocks }, { content: blocks, isError: false }]) {
      const item = { ...screenshot, viewedImagePath: "/tmp/blk.png", output };
      expect(turnItemOutputText(item)).toBe("Read /tmp/blk.png.\n[image]\n[image]");
      expect(turnItemOutputImages(item)).toHaveLength(1);
    }
  });
});
