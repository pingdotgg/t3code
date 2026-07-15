import { describe, expect, it } from "vite-plus/test";

import {
  chatAttachmentAccessibilityLabel,
  formatChatAttachmentSize,
} from "./chatAttachmentPresentation";

describe("chat attachment presentation", () => {
  it("formats attachment sizes for the transcript", () => {
    expect(formatChatAttachmentSize(512)).toBe("512 B");
    expect(formatChatAttachmentSize(1024)).toBe("1 KB");
    expect(formatChatAttachmentSize(1536)).toBe("1.5 KB");
    expect(formatChatAttachmentSize(2 * 1024 * 1024)).toBe("2 MB");
  });

  it("provides an accessible image description", () => {
    expect(chatAttachmentAccessibilityLabel("screenshot.png", 1536)).toBe(
      "screenshot.png, 1.5 KB image. Opens a full-screen preview.",
    );
  });
});
