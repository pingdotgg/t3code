import { describe, expect, it } from "vitest";

import {
  buildInlineTerminalContextText,
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
});
