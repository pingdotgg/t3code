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

const plain = (input: string) => terminalOutputPlainText(normalizeTerminalOutput(input).text);

describe("appendTerminalOutput", () => {
  it("keeps colours as canonical codes that reset at each line end", () => {
    expect(normalizeTerminalOutput("\u001b[1;32mPASS\u001b[0m ok\u001b]0;title\u0007\n").text).toBe(
      "\u001b[0;1;32mPASS\u001b[0m ok\n",
    );
    // A colour left on across a newline is restated on the next line.
    expect(normalizeTerminalOutput("\u001b[31mone\ntwo").text).toBe(
      "\u001b[0;31mone\u001b[0m\n\u001b[0;31mtwo\u001b[0m",
    );
  });

  it("keeps only the latest frame of a carriage-return progress bar", () => {
    expect(feed(["[1/3]", "\r[2/3]", "\r[3/3] done\nnext"]).text).toBe("[3/3] done\nnext");
  });

  it("redraws several lines in place when the cursor moves up", () => {
    // docker pull / pnpm style: print two bars, move up two lines, redraw both.
    const frames = [
      "layer a: 10%\nlayer b: 10%\n",
      "\u001b[2A\u001b[2Klayer a: 60%\n\u001b[2Klayer b: 40%\n",
      "\u001b[2A\u001b[2Klayer a: done\n\u001b[2Klayer b: done\n",
    ];
    expect(feed(frames).text).toBe("layer a: done\nlayer b: done\n");
  });

  it("erases from the cursor to the end of the screen", () => {
    // log-update style: move up, clear everything below, print the new frame.
    expect(plain("status 1\ndetail 1\n\u001b[2A\u001b[Jstatus 2\n")).toBe("status 2\n");
  });

  it("overwrites in place like a terminal: carriage return, backspace, columns", () => {
    expect(plain("progress 100%\rdone\u001b[K")).toBe("done");
    expect(plain("abc\b\bX")).toBe("aXc");
    expect(plain("12345\u001b[3GX")).toBe("12X45");
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
  });

  it("drops binary control bytes but keeps tabs and replacement characters", () => {
    expect(normalizeTerminalOutput("a\u0000b\u0007\tc�\u0090d").text).toBe("ab\tc�d");
  });

  it("keeps a bounded tail that starts on a fresh line", () => {
    const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n");
    const state = feed([lines], 1_000);
    expect(state.truncated).toBe(true);
    expect(state.text.length).toBeLessThanOrEqual(1_000);
    expect(state.text.startsWith("line ")).toBe(true);
    expect(state.text.endsWith("line 1999")).toBe(true);
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

  it("drops an escape sequence that never terminates and resumes after it", () => {
    expect(feed(["ok\u001b]", "x".repeat(200), "\nafter"]).text).toBe("ok\nafter");
  });
});

describe("terminalOutputResumeText", () => {
  it("lets a viewer that starts from it apply later chunks exactly as the source does", () => {
    // Mid-redraw: cursor two lines up, a colour on, and half an escape pending.
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

  it("survives a huge cursor move without throwing", () => {
    expect(() => normalizeTerminalOutput("a\u001b[999999999999Cb")).not.toThrow();
  });
});

describe("terminalOutputTail", () => {
  it("never begins on a lone low surrogate", () => {
    const text = `${"a".repeat(10)}😀${"b".repeat(4)}`;
    const tail = terminalOutputTail(text, 5);
    expect(tail.text).toBe("bbbb");
  });

  it("never splits a colour code and keeps the colour in force when cutting a line", () => {
    const text = `\u001b[0;32m${"g".repeat(100)}\u001b[0m`;
    const cut = terminalOutputTail(text, 10).text;
    expect(cut.startsWith("\u001b[0;32m")).toBe(true);
    expect(terminalOutputPlainText(cut)).toMatch(/^g+$/u);
  });
});

describe("terminalOutputSpans", () => {
  it("resolves standard, 256-colour and true-colour codes against the palette", () => {
    const text = normalizeTerminalOutput(
      "\u001b[31mred\u001b[0m \u001b[1;38;5;196mhot\u001b[0m \u001b[38;2;1;2;3mrgb\u001b[0m",
    ).text;
    expect(terminalOutputSpans(text, TERMINAL_PALETTES.dark)).toEqual([
      { text: "red", style: { color: TERMINAL_PALETTES.dark[1] } },
      { text: " ", style: null },
      { text: "hot", style: { color: "rgb(255,0,0)", bold: true } },
      { text: " ", style: null },
      { text: "rgb", style: { color: "rgb(1,2,3)" } },
    ]);
  });

  it("keeps text on a coloured background readable on either palette", () => {
    // "PASS" badge: black on green; "FAIL" badge: grey-white on red.
    const text = normalizeTerminalOutput(
      "\u001b[30;42m PASS \u001b[0m\u001b[1;37;41m FAIL \u001b[0m",
    ).text;
    for (const palette of [TERMINAL_PALETTES.light, TERMINAL_PALETTES.dark]) {
      for (const span of terminalOutputSpans(text, palette)) {
        expect(span.style?.color === undefined).toBe(false);
      }
    }
    const [pass, fail] = terminalOutputSpans(text, TERMINAL_PALETTES.light);
    expect(pass?.style?.color).toBe("#ffffff");
    expect(fail?.style?.color).toBe("#ffffff");
  });

  it("collapses the rest into plain text past the span limit", () => {
    const text = normalizeTerminalOutput("\u001b[31mx\u001b[32my".repeat(50)).text;
    const spans = terminalOutputSpans(text, TERMINAL_PALETTES.light, 10);
    expect(spans.length).toBe(11);
    expect(spans.at(-1)?.style).toBeNull();
    expect(spans.map((span) => span.text).join("")).toBe("xy".repeat(50));
  });
});
