import { describe, expect, it } from "vite-plus/test";

import {
  MAX_COLLAPSED_USER_MESSAGE_LENGTH,
  MAX_COLLAPSED_USER_MESSAGE_LINES,
  shouldCollapseUserMessage,
} from "./chatMessages.ts";

describe("shouldCollapseUserMessage", () => {
  it("keeps ordinary prompts expanded", () => {
    expect(shouldCollapseUserMessage("Please fix the terminal layout.")).toBe(false);
  });

  it("collapses prompts beyond the web UI character limit", () => {
    expect(shouldCollapseUserMessage("x".repeat(MAX_COLLAPSED_USER_MESSAGE_LENGTH + 1))).toBe(true);
  });

  it("collapses prompts beyond the web UI line limit", () => {
    expect(
      shouldCollapseUserMessage(
        Array.from(
          { length: MAX_COLLAPSED_USER_MESSAGE_LINES + 1 },
          (_, index) => `line ${index}`,
        ).join("\n"),
      ),
    ).toBe(true);
  });
});
