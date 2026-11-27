import { expect, it } from "vite-plus/test";

import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  terminalOutputResumeText,
} from "./terminalOutput.ts";

const red = "\u001b[0;31mX\u001b[0m";

it.each([
  ["abc\u001b\r[31mX", red + "bc"],
  ["abc\u001b\u0007\r[31mX", red + "bc"],
  ["abc\u001b[\u0007\r31mX", red + "bc"],
  ["abc\u001b\n[31mX", "abc\n" + red],
  ["abcde\u001b\b\b[31mX", "abc" + red + "e"],
  ["abc\u001b\r\u001b[31mX", red + "bc"],
  ["abc\u001b\rXhidden\u001b\\Z", "Zbc"],
])("executes line controls after ESC across every split: %j", (input, expected) => {
  for (let cut = 0; cut <= input.length; cut += 1) {
    const state = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, input.slice(0, cut));
    const chunk = input.slice(cut);
    const resumed = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, terminalOutputResumeText(state));
    expect(appendTerminalOutput(state, chunk).text).toBe(expected);
    expect(appendTerminalOutput(resumed, chunk).text).toBe(expected);
  }
});
