import { describe, expect, it } from "vite-plus/test";

import { stripTerminalEscapes } from "./stripTerminalEscapes.ts";

describe("stripTerminalEscapes", () => {
  it("strips BEL-terminated OSC sequences", () => {
    expect(stripTerminalEscapes("\u001b]0;/repo: ready\u0007openai/gpt-4o")).toBe("openai/gpt-4o");
  });

  it("strips ST-terminated OSC sequences", () => {
    expect(stripTerminalEscapes("\u001b]0;/repo: ready\u001b\\build (primary)")).toBe(
      "build (primary)",
    );
  });

  it("strips multiple OSC sequences in one payload", () => {
    expect(stripTerminalEscapes("a\u001b]2;t\u0007b\u001b]8;;http://x\u001b\\c")).toBe("abc");
  });

  it("strips CSI color and cursor sequences", () => {
    expect(stripTerminalEscapes("\u001b[1mgpt-4o\u001b[0m")).toBe("gpt-4o");
    expect(stripTerminalEscapes("\u001b[38;5;208mhi\u001b[39m")).toBe("hi");
    expect(stripTerminalEscapes("\u001b[38:2::1:2:3mhi\u001b[m")).toBe("hi");
    expect(stripTerminalEscapes("\u001b[2J\u001b[Hready")).toBe("ready");
  });

  it("leaves ordinary text untouched", () => {
    const text = "plain text 123 [not an escape] \\slash";
    expect(stripTerminalEscapes(text)).toBe(text);
  });

  it("keeps unterminated escape prefixes as literal text", () => {
    // No BEL/ST terminator: the OSC match must not swallow the trailing text.
    expect(stripTerminalEscapes("\u001b]0;partial openai/gpt-4o")).toBe(
      "\u001b]0;partial openai/gpt-4o",
    );
  });

  it("strips mixed OSC, CSI, and text", () => {
    expect(stripTerminalEscapes("\u001b]0;tmp: ready\u0007\u001b[32mok\u001b[39m done")).toBe(
      "ok done",
    );
  });
});
