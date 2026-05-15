import { describe, expect, it } from "vitest";

import {
  buildInlineTerminalContextText,
  buildRenderedUserMessageText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";

describe("userMessageTerminalContexts", () => {
  it("builds plain inline terminal text labels", () => {
    expect(
      buildInlineTerminalContextText([
        { header: "Terminal 1 lines 12-13" },
        { header: "Terminal 2 line 4" },
      ]),
    ).toBe("@terminal-1:12-13 @terminal-2:4");
  });

  it("formats individual inline terminal labels compactly", () => {
    expect(formatInlineTerminalContextLabel("Terminal 1 lines 12-13")).toBe("@terminal-1:12-13");
    expect(formatInlineTerminalContextLabel("Terminal 2 line 4")).toBe("@terminal-2:4");
  });

  it("detects inline terminal labels embedded in user message text", () => {
    expect(
      textContainsInlineTerminalContextLabels("yo @terminal-1:12-13 whats up", [
        { header: "Terminal 1 lines 12-13" },
      ]),
    ).toBe(true);
    expect(
      textContainsInlineTerminalContextLabels("yo whats up", [
        { header: "Terminal 1 lines 12-13" },
      ]),
    ).toBe(false);
  });

  it("replaces hidden inline terminal tokens with the rendered chip labels", () => {
    expect(
      buildRenderedUserMessageText("yo @terminal-1:12-13 whats up", [
        { header: "Terminal 1 lines 12-13" },
      ]),
    ).toBe("yo Terminal 1 lines 12-13 whats up");
  });

  it("ignores empty terminal context headers while replacing visible inline labels", () => {
    expect(
      buildRenderedUserMessageText("yo @terminal-1:12-13 whats up", [
        { header: "   " },
        { header: "Terminal 1 lines 12-13" },
      ]),
    ).toBe("yo Terminal 1 lines 12-13 whats up");
  });

  it("prefixes standalone rendered chip labels ahead of the remaining text", () => {
    expect(
      buildRenderedUserMessageText("follow-up text", [{ header: "Terminal 1 lines 12-13" }]),
    ).toBe("Terminal 1 lines 12-13 follow-up text");
  });
});
