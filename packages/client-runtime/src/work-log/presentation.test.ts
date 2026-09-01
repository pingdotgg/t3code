import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import { resolveViewedImageAsset, workEntryViewedImagePath } from "./presentation.js";

describe("workEntryViewedImagePath", () => {
  const entry = { label: "Read", tone: "tool" } as const;

  it("returns a single image path from supported read entries", () => {
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: " assets/a.png " }),
    ).toBe("assets/a.png");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool_call",
        toolTitle: "Read file",
        detail: "C:\\workspace\\a.webp",
      }),
    ).toBe("C:\\workspace\\a.webp");
  });

  it("rejects non-image, multi-line, and non-read details", () => {
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.txt" }),
    ).toBeNull();
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.png\nb.png" }),
    ).toBeNull();
    expect(workEntryViewedImagePath({ ...entry, detail: "a.png" })).toBeNull();
  });
});

describe("resolveViewedImageAsset", () => {
  const threadId = ThreadId.make("thread-1");

  it("loads t3 attachment paths as attachments", () => {
    const attachmentId =
      "11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222";
    expect(
      resolveViewedImageAsset(`/Users/demo/.t3/dev/attachments/${attachmentId}.png`, {
        threadId,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      resource: { _tag: "attachment", attachmentId },
      alt: `${attachmentId}.png`,
      srcFragment: "",
    });
  });

  it("normalizes workspace image sources", () => {
    expect(
      resolveViewedImageAsset("screens/logo.svg?v=2#mark", {
        threadId,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      resource: {
        _tag: "workspace-file",
        threadId,
        path: "/workspace/screens/logo.svg",
      },
      alt: "logo.svg",
      srcFragment: "#mark",
    });
    expect(resolveViewedImageAsset("https://example.com/logo.png", { threadId })).toBeNull();
  });
});
