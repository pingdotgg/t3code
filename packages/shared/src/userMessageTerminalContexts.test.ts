import { describe, expect, it } from "vite-plus/test";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  splitUserMessageTerminalContexts,
} from "./userMessageTerminalContexts.ts";

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

  it("segments text and chips without changing whitespace or repeated visible labels", () => {
    const context = { header: "Terminal 1 line 12", body: "output" };
    expect(
      splitUserMessageTerminalContexts("  @terminal-1:12 and @terminal-1:12  ", [context]),
    ).toEqual([
      { kind: "text", text: "  ", start: 0 },
      { kind: "terminal", context, start: 2 },
      { kind: "text", text: " and @terminal-1:12  ", start: 16 },
    ]);
  });

  it("replaces repeated contexts with distinct chip positions", () => {
    const context = { header: "Terminal 1 line 12" };
    expect(
      splitUserMessageTerminalContexts("@terminal-1:12@terminal-1:12", [context, context]),
    ).toEqual([
      { kind: "terminal", context, start: 0 },
      { kind: "terminal", context, start: 14 },
    ]);
  });

  it("leaves the whole prompt intact if a label is missing or out of order", () => {
    const contexts = [{ header: "Terminal 1 line 12" }, { header: "Terminal 2 line 4" }];
    expect(splitUserMessageTerminalContexts("@terminal-1:12 missing", contexts)).toBeNull();
    expect(splitUserMessageTerminalContexts("@terminal-2:4 @terminal-1:12", contexts)).toBeNull();
  });

  it("preserves plain text without contexts and supports an empty prompt", () => {
    expect(splitUserMessageTerminalContexts(" plain text ", [])).toEqual([
      { kind: "text", text: " plain text ", start: 0 },
    ]);
    expect(splitUserMessageTerminalContexts("", [])).toEqual([]);
  });
});
