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

it.each(["K", "J"])("resets tab stops when erase-start %s clears the last wide glyph", (final) => {
  const source = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, "𐐀".repeat(8) + "界", 16);
  const output = appendTerminalOutput(source, `\u001b[8G\u001b[1${final}\r\tZ`, 16);
  expect(output.text).toBe("        Z");
});

it("restores scrollback, a saved cursor, and a pending escape before a tabbed redraw", () => {
  const source = appendTerminalOutput(
    EMPTY_TERMINAL_OUTPUT,
    "Build started\n" + "working\n".repeat(63) + "\u001b[2Jabc\tZ\u001b[5G\u001b7\u001b[9G\u001b[3",
  );
  const viewer = restoreTerminalOutput(terminalOutputResumeText(source));
  expect(appendTerminalOutput(viewer, "1m\u001b8X").text).toBe(
    "Build started\nabc \u001b[0;31mX\u001b[0m   Z",
  );
});
