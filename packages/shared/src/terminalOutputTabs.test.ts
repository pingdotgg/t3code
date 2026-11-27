import { describe, expect, it } from "vite-plus/test";

import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  terminalOutputCollapseRedraws,
  terminalOutputResumeText,
} from "./terminalOutput.ts";

describe("tab stops in retained command output", () => {
  it.each([
    ["abcdefghijklmno", "\tZ", 8, "jklmno Z"],
    ["界abcdefghijklm", "\tZ", 8, "hijklm Z"],
    ["abcdefghijklmno\r", "\tZ", 8, "hZjklmno"],
    ["abcde\nabc\u001b[A", "\u001b[B\tZ", 6, "     Z"],
  ])("preserves the tab stop after trimming %j", (prefix, chunk, maxChars, expected) => {
    const source = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, prefix, maxChars);
    const resumed = appendTerminalOutput(
      EMPTY_TERMINAL_OUTPUT,
      terminalOutputResumeText(source),
      maxChars,
    );
    for (const state of [source, resumed]) {
      expect(appendTerminalOutput(state, chunk, maxChars).text).toBe(expected);
    }
  });
});

describe("tab stops in notebook redraws", () => {
  it.each([
    ["a\tbcdefghij\rXY", "XY      bcdefghij"],
    ["abc\tZ\rabc X", "abc X   Z"],
    ["123456789\r\tZ", "12345678Z"],
    ["界abcde\tZ\rXY", "XYabcde Z"],
  ])("redraws %j at terminal columns", (input, expected) => {
    expect(terminalOutputCollapseRedraws(input)).toBe(expected);
  });
});
