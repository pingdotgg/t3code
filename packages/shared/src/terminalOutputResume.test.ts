import { expect, it } from "vite-plus/test";

import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  TERMINAL_OUTPUT_TAIL_CHARS,
  terminalOutputResumeText,
} from "./terminalOutput.ts";

it("recovers retained scrollback when a redraw shortens the full output tail", () => {
  const history = "Build started\n";
  const progress = "x".repeat(TERMINAL_OUTPUT_TAIL_CHARS);
  const source = appendTerminalOutput(
    EMPTY_TERMINAL_OUTPUT,
    history + "working\n".repeat(63) + "\u001b[2J" + progress,
  );
  const viewer = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, terminalOutputResumeText(source));
  expect(viewer.text).toBe(progress);

  const redraw = "\r\u001b[2KProgress: done";
  expect(appendTerminalOutput(source, redraw).text).toBe(history + "Progress: done");
  expect(appendTerminalOutput(viewer, redraw).text).toBe(history + "Progress: done");
});
