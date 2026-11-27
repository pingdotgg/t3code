import { describe, expect, it } from "vite-plus/test";

import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  restoreTerminalOutput,
  terminalOutputCollapseRedraws,
  terminalOutputResumeText,
} from "./terminalOutput.ts";

describe("tab stops in retained command output", () => {
  it.each([
    ["abcdefghijklmno", "\tZ", 8, "jklmno Z"],
    ["界abcdefghijklm", "\tZ", 8, "hijklm Z"],
    ["abcdefghijklmno\r", "\tZ", 8, "hZjklmno"],
    ["abcde\nabcdEF\u001b[A", "\u001b[B\u001b[4G\tZ", 8, "dEF  Z"],
  ])("preserves the tab stop after trimming %j", (prefix, chunk, maxChars, expected) => {
    const source = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, prefix, maxChars);
    const resumed = restoreTerminalOutput(terminalOutputResumeText(source), maxChars);
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

describe("tab stops after erasing trimmed command output", () => {
  it.each([
    ["\r\u001b[2K", "        Z"],
    ["\r\u001b[K", "        Z"],
    ["\r\u001b[J", "        Z"],
    ["\n\u001b[1J\u001b[A", "        Z\n"],
  ])("restores the default tab stop after %j", (erase, expected) => {
    const trimmed = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, "x".repeat(17), 16);
    expect(appendTerminalOutput(trimmed, erase + "\tZ", 16).text).toBe(expected);
  });
});

it("ignores a snapshot tab offset in raw command output", () => {
  const raw = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, "a\u001b[>7 t\tZ");
  expect(raw.text).toBe("a       Z");
});
