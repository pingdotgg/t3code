import { describe, expect, it } from "vitest";

import { threadMarkdownFilename } from "./threadMarkdownExport";

describe("threadMarkdownFilename", () => {
  it("uses a portable Forma export filename", () => {
    expect(threadMarkdownFilename("  Fix: mobile / relay!  ", "12345678-abcd")).toBe(
      "fix-mobile-relay-12345678.md",
    );
  });

  it("falls back for titles without filename characters", () => {
    expect(threadMarkdownFilename("🎉", "abcdef12-3456")).toBe("thread-abcdef12.md");
  });
});
