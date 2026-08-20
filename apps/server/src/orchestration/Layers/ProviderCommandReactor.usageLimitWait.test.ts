import { describe, expect, it } from "vite-plus/test";

import { buildQueuedUsageLimitTurnInput } from "./ProviderCommandReactor.ts";

describe("buildQueuedUsageLimitTurnInput", () => {
  it("keeps one queued message unchanged", () => {
    expect(buildQueuedUsageLimitTurnInput([{ text: "Fix the navbar" }])).toEqual({
      messageText: "Fix the navbar",
      attachments: [],
    });
  });

  it("combines queued messages and preserves every attachment", () => {
    const firstAttachment = {
      type: "image" as const,
      id: "image-1",
      name: "navbar.png",
      mimeType: "image/png",
      sizeBytes: 123,
    };
    const secondAttachment = {
      type: "image" as const,
      id: "image-2",
      name: "border.png",
      mimeType: "image/png",
      sizeBytes: 456,
    };

    const result = buildQueuedUsageLimitTurnInput([
      { text: "Fix the navbar", attachments: [firstAttachment] },
      { text: "", attachments: [secondAttachment] },
    ]);

    expect(result.messageText).toContain("Message 1:\nFix the navbar");
    expect(result.messageText).toContain("Message 2:\n(attachments only)");
    expect(result.attachments).toEqual([firstAttachment, secondAttachment]);
  });
});
