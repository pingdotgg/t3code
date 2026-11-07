import { describe, expect, it } from "vite-plus/test";

import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  normalizeTerminalOutput,
  TERMINAL_PALETTES,
  terminalOutputPlainText,
  terminalOutputResumeText,
  terminalOutputSpans,
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
  it("keeps only the latest frame of a carriage-return progress bar", () => {
    expect(feed(["[1/3]", "\r[2/3]", "\r[3/3] done\nnext"]).text).toBe("[3/3] done\nnext");
  });

  it.each([
    { chunks: ["A\tB"], text: "A       B", col: 9 },
    { chunks: ["abcdefgh\tX"], text: "abcdefgh        X", col: 17 },
    { chunks: ["A\t"], text: "A", col: 8 },
    { chunks: ["A\tB\rXY"], text: "XY      B", col: 2 },
    { chunks: ["A\tB", "\u001b[9GX"], text: "A       X", col: 9 },
    { chunks: ["A\tB", "\u001b[1;9HX"], text: "A       X", col: 9 },
    { chunks: ["abcdefghij\rA\tX"], text: "AbcdefghXj", col: 9 },
  ])("moves tabs to the next eight-column stop: $chunks", ({ chunks, text, col }) => {
    const state = feed(chunks);
    expect(state.text).toBe(text);
    expect(state.screen.col).toBe(col);
    expect(
      appendTerminalOutput(
        appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, terminalOutputResumeText(state)),
        "Z",
      ).text,
    ).toBe(appendTerminalOutput(state, "Z").text);
  });

  it("redraws several lines in place when the cursor moves up", () => {
    const frames = [
      "layer a: 10%\nlayer b: 10%\n",
      "\u001b[2A\u001b[2Klayer a: 60%\n\u001b[2Klayer b: 40%\n",
      "\u001b[2A\u001b[2Klayer a: done\n\u001b[2Klayer b: done\n",
    ];
    expect(feed(frames).text).toBe("layer a: done\nlayer b: done\n");
  });

  it("treats CRLF as one newline even when the pair is split across chunks", () => {
    const state = feed(["one\r", "\ntwo\r\n"]);
    expect(state.text).toBe("one\ntwo\n");
    expect(state.pending).toBe("");
  });

  it("holds an escape sequence split across chunks until it finishes", () => {
    const first = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, "red: \u001b[3");
    expect(first.text).toBe("red: ");
    expect(feed(["red: \u001b[3", "1mR\u001b[0m"]).text).toBe("red: \u001b[0;31mR\u001b[0m");
    expect(
      terminalOutputSpans(feed(["\u001b[38:2::12:", "34:56mR"]).text, TERMINAL_PALETTES.dark),
    ).toEqual([{ text: "R", style: { color: "rgb(12,34,56)" } }]);
  });

  it("keeps a bounded tail that starts on a fresh line", () => {
    const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n");
    const state = feed([lines], 1_000);
    expect(state.truncated).toBe(true);
    expect(state.text.length).toBeLessThanOrEqual(1_000);
    expect(state.text.startsWith("line ")).toBe(true);
    expect(state.text.endsWith("line 1999")).toBe(true);
    // A newline a quarter of the budget past the cut is too far to start on.
    expect(feed(["abcdefgh\nij\nklmnop"], 8).text).toBe("klmnop");
    expect(feed(["abcdefgh\nijk\nlmnop"], 8).text).toBe("jk\nlmnop");
  });

  it("stays bounded across many appends of huge output, including one endless line", () => {
    let state = EMPTY_TERMINAL_OUTPUT;
    for (let index = 0; index < 5_000; index += 1) {
      state = appendTerminalOutput(state, "y\n".repeat(200), 4_096);
    }
    expect(state.text.length).toBeLessThanOrEqual(4_096);
    expect(state.truncated).toBe(true);
    for (let index = 0; index < 1_000; index += 1) {
      state = appendTerminalOutput(state, ".".repeat(100), 4_096);
    }
    expect(state.text.length).toBeLessThanOrEqual(4_096);
    expect(state.text.endsWith(".")).toBe(true);
  });

  it("hides a long string sequence's payload however it is split into chunks", () => {
    const input = `a\u001b]0;${"t".repeat(100)}\u0007b`;
    expect(feed([input]).text).toBe("ab");
    expect(feed(["a\u001b]0;", "t".repeat(100), "\u0007b"]).text).toBe("ab");
    expect(feed([`a\u001b]0;${"t".repeat(80)}`, "\u001b", "\\b"]).text).toBe("ab");
  });

  it("drops an escape sequence that never terminates and resumes after it", () => {
    expect(feed(["ok\u001b]", "x".repeat(200), "\nafter"]).text).toBe("ok\nafter");
    expect(feed(["ok\u001b]0;title\u001b", "\u001b[31mred"]).text).toBe(
      "ok\u001b[0;31mred\u001b[0m",
    );
  });
});

describe("appendTerminalOutput edge cases from review", () => {
  const boldRed = { color: TERMINAL_PALETTES.dark[1], fontWeight: "600" } as const;
  it.each([
    [
      "a curly underline",
      "\u001b[1;31m\u001b[4:3mX",
      { ...boldRed, textDecorationLine: "underline" },
    ],
    ["underline off in colon form", "\u001b[1;31m\u001b[4:0mX", boldRed],
    ["a true-colour underline colour", "\u001b[1;31m\u001b[58;2;255;0;0mX", boldRed],
    ["a 256-colour underline colour", "\u001b[58;5;31mX", null],
    [
      "a colon-form underline colour",
      "\u001b[4m\u001b[58:2::255:0:0mX",
      { textDecorationLine: "underline" },
    ],
    ["extra fields in a colon-form indexed underline colour", "\u001b[58:5:0:32mX", null],
    [
      "extra fields in a colon-form indexed colour",
      "\u001b[38:5:1:4mX",
      { color: TERMINAL_PALETTES.dark[1] },
    ],
    [
      "a true colour with its fields after colons",
      "\u001b[38;2:255:0:0;1mX",
      { color: "rgb(255,0,0)", fontWeight: "600" },
    ],
    [
      "an indexed colour with its index after a colon",
      "\u001b[38;5:1;4mX",
      { color: TERMINAL_PALETTES.dark[1], textDecorationLine: "underline" },
    ],
    [
      "a semicolon-form colour value that looks like a colour code",
      "\u001b[38;5;38;2:1:2:3mX",
      { color: "rgb(0,175,215)", opacity: 0.65 },
    ],
  ])("reads %s without disturbing the other attributes", (_, input, style) => {
    const text = normalizeTerminalOutput(input).text;
    expect(terminalOutputSpans(text, TERMINAL_PALETTES.dark)).toEqual([{ text: "X", style }]);
    for (let cut = 1; cut < input.length; cut += 1) {
      expect(feed([input.slice(0, cut), input.slice(cut)]).text).toBe(text);
    }
  });

  it("leaves the screen and cursor alone for unsupported erase modes", () => {
    for (const sequence of ["3K", "4J", "99K", "99J"]) {
      const input = `a\nb\nc\u001b[${sequence}X`;
      expect(feed([input]).text).toBe("a\nb\ncX");
      for (let cut = 1; cut < input.length; cut += 1) {
        expect(feed([input.slice(0, cut), input.slice(cut)]).text).toBe("a\nb\ncX");
      }
    }
  });

  it("clears only scrollback on ESC[3J", () => {
    const lines = Array.from({ length: 70 }, (_, index) => `line ${index}`).join("\n");
    const state = feed([lines, "\u001b[3J"]);
    expect(state.text.startsWith("line 6\n")).toBe(true);
    expect(state.text.endsWith("line 69")).toBe(true);
    expect(state.truncated).toBe(true);
  });

  it("keeps the whole window within the tail when every line is long", () => {
    const long = `${"x".repeat(900)}\n`;
    const state = feed([long.repeat(64)], 4_096);
    const windowChars = state.screen.lines.reduce(
      (total, line) => total + line.reduce((sum, run) => sum + run.text.length, 0),
      0,
    );
    expect(windowChars).toBeLessThanOrEqual(4_096);
    expect(state.text.length).toBeLessThanOrEqual(4_096);
  });
});

describe("appendTerminalOutput under adversarial output", () => {
  it("ignores unsupported cursor-control parameters without corrupting the screen", () => {
    for (const sequence of ["1.5A", "1.5G", "1$K", "1$J", ">1A", "?25l", "1:2A", "1:2K", "1:2J"]) {
      const input = `a\nb\nc\u001b[${sequence}X`;
      expect(feed([input]).text).toBe("a\nb\ncX");
      for (let cut = 1; cut < input.length; cut += 1) {
        expect(feed([input.slice(0, cut), input.slice(cut)]).text).toBe("a\nb\ncX");
      }
    }
  });

  it("drops escape sequences with intermediate bytes without printing their final byte", () => {
    for (const sequence of ["#8", "#6", "%G", " F", "-A", ".A", "(%5", "(B"]) {
      const input = `a\u001b${sequence}b`;
      expect(feed([input]).text).toBe("ab");
      for (let cut = 1; cut < input.length; cut += 1) {
        expect(feed([input.slice(0, cut), input.slice(cut)]).text).toBe("ab");
      }
    }
    for (const [interrupted, expected] of [
      ["a\u001b#\u001b[31mb", feed(["a\u001b[31mb"]).text],
      ["a\u001b#\n8b", "a\n8b"],
    ] as const) {
      for (let cut = 0; cut < interrupted.length; cut += 1) {
        expect(feed([interrupted.slice(0, cut), interrupted.slice(cut)]).text).toBe(expected);
      }
    }
  });

  it("gives the same result however the output is split into chunks", () => {
    const input =
      "A\tB\rXY\nA\tB\u001b[9GX\nA\tB\u001b[1;9HX\nabcdefghij\rA\tX\n" +
      "abcdef\rX\u001b[31mred\u001b[0m\nnext line\r\u001b[2Kdone\n" +
      "\u001b[1;31mbold red\u001b[mplain\u001b[38:2::12:34:56mrgb\u001b[0m\n" +
      "\u001b[1;31mbold red again\u001b[mplain again\u001b[38:2::12:34:56mrgb again\u001b[0m";
    for (const maxChars of [3, 1_024]) {
      const whole = feed([input], maxChars).text;
      for (let cut = 1; cut < input.length; cut += 1) {
        expect(feed([input.slice(0, cut), input.slice(cut)], maxChars).text).toBe(whole);
      }
    }
    expect(feed(["abcdef", "\rX"], 3).text).toBe(feed(["abcdef\rX"], 3).text);
  });
});

describe("terminalOutputResumeText", () => {
  it("lets a viewer that starts from it apply later chunks exactly as the source does", () => {
    const chunks = [
      "a: 1%\nb: 1%\n",
      "\u001b[2A\u001b[2K\u001b[33ma: 5",
      "0%\u001b[0",
      "m\n\u001b[2Kb: 50%\n",
    ];
    const source = feed(chunks.slice(0, 3));
    const viewer = appendTerminalOutput(
      appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, terminalOutputResumeText(source)),
      chunks[3]!,
    );
    expect(viewer.text).toBe(feed(chunks).text);
    expect(terminalOutputPlainText(viewer.text)).toBe("a: 50%\nb: 50%\n");
  });
});

describe("terminalOutputResumeText with a saved cursor or trimmed output", () => {
  it("restores a cursor saved before the resync", () => {
    const source = feed(["abc\u001b7def"]);
    const viewer = appendTerminalOutput(
      appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, terminalOutputResumeText(source)),
      "\u001b8X",
    );
    expect(viewer.text).toBe("abcXef");
  });

  it("stays on the right line when early output was trimmed away", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const source = feed([lines, "\u001b[1A\rLINE"], 120);
    const viewer = appendTerminalOutput(
      appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, terminalOutputResumeText(source), 120),
      " edited",
      120,
    );
    expect(viewer.text).toBe(appendTerminalOutput(source, " edited", 120).text);
  });
});

describe("terminalOutputTail", () => {
  it("never begins on a lone low surrogate", () => {
    const text = `${"a".repeat(10)}😀${"b".repeat(4)}`;
    const tail = terminalOutputTail(text, 5);
    expect(tail.text).toBe("bbbb");
  });
});

describe("terminalOutputSpans", () => {
  it("collapses the rest into plain text past the span limit", () => {
    const text = normalizeTerminalOutput("\u001b[31mx\u001b[32my".repeat(50)).text;
    const spans = terminalOutputSpans(text, TERMINAL_PALETTES.light, 10);
    expect(spans.length).toBe(11);
    expect(spans.at(-1)?.style).toBeNull();
    expect(spans.map((span) => span.text).join("")).toBe("xy".repeat(50));
  });
});
