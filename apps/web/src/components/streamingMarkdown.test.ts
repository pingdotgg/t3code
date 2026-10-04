import { describe, expect, it } from "vitest";

import { appendStreamingMarkdown, beginStreamingMarkdown } from "./streamingMarkdown";

describe("streaming Markdown segments", () => {
  it("falls back when a stream replaces rather than appends its prior text", () => {
    const previous = beginStreamingMarkdown("First paragraph\n\nSecond paragraph");
    const replacement = appendStreamingMarkdown(previous, "Replacement text");

    expect(replacement.mode).toBe("full");
    expect(replacement.sourceText).toBe("Replacement text");
  });
});
