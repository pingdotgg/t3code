import { describe, expect, it } from "vite-plus/test";

import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  normalizeTerminalOutput,
  terminalOutputTail,
  type TerminalOutputState,
} from "./terminalOutput.ts";

function feed(chunks: ReadonlyArray<string>, maxChars?: number): TerminalOutputState {
  return chunks.reduce(
    (state, chunk) => appendTerminalOutput(state, chunk, maxChars),
    EMPTY_TERMINAL_OUTPUT,
  );
}

describe("appendTerminalOutput", () => {
  it("removes colour and cursor escape sequences", () => {
    expect(normalizeTerminalOutput("\u001b[1;32mPASS\u001b[0m ok\u001b]0;title\u0007\n").text).toBe(
      "PASS ok\n",
    );
  });

  it("keeps only the latest frame of a carriage-return progress bar", () => {
    expect(feed(["[1/3]", "\r[2/3]", "\r[3/3] done\nnext"]).text).toBe("[3/3] done\nnext");
  });

  it("treats CRLF as one newline even when the pair is split across chunks", () => {
    const state = feed(["one\r", "\ntwo\r\n"]);
    expect(state.text).toBe("one\ntwo\n");
    expect(state.pending).toBe("");
  });

  it("holds an escape sequence split across chunks until it finishes", () => {
    const first = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, "red: \u001b[3");
    expect(first.text).toBe("red: ");
    expect(feed(["red: \u001b[3", "1mR\u001b[0m"]).text).toBe("red: R");
  });

  it("drops binary control bytes but keeps tabs and replacement characters", () => {
    expect(normalizeTerminalOutput("a\u0000b\u0007\tc�\u0090d").text).toBe("ab\tc�d");
  });

  it("applies backspaces to the current line", () => {
    expect(normalizeTerminalOutput("abc\b\bX").text).toBe("aX");
  });

  it("keeps a bounded tail that starts on a fresh line", () => {
    const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n");
    const state = feed([lines], 1_000);
    expect(state.truncated).toBe(true);
    expect(state.text.length).toBeLessThanOrEqual(1_000);
    expect(state.text.startsWith("line ")).toBe(true);
    expect(state.text.endsWith("line 1999")).toBe(true);
  });

  it("stays bounded across many appends of huge output", () => {
    let state = EMPTY_TERMINAL_OUTPUT;
    for (let index = 0; index < 5_000; index += 1) {
      state = appendTerminalOutput(state, "y\n".repeat(200), 4_096);
    }
    expect(state.text.length).toBeLessThanOrEqual(4_096);
    expect(state.truncated).toBe(true);
  });

  it("drops an escape sequence that never terminates and resumes after it", () => {
    expect(feed(["ok\u001b]", "x".repeat(200), "\nafter"]).text).toBe("ok\nafter");
  });
});

describe("terminalOutputTail", () => {
  it("never begins on a lone low surrogate", () => {
    const text = `${"a".repeat(10)}😀${"b".repeat(4)}`;
    const tail = terminalOutputTail(text, 5);
    expect(tail.text).toBe("bbbb");
  });
});
