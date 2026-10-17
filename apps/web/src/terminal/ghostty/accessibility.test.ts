import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  accessibleRowText,
  collapseTerminalOverwrites,
  stripTerminalControls,
  TerminalAnnouncer,
} from "./accessibility";

describe("stripTerminalControls", () => {
  it("keeps printable text and line breaks only", () => {
    expect(stripTerminalControls("\x1b[1;32mok\x1b[0m\x1b]0;title\x07\x07\r\n\x1b(B$ ")).toEqual({
      text: "ok\r\n$ ",
      pending: "",
    });
  });

  it("drops concealed text from the given starting state, but not 256-color index 8", () => {
    expect(stripTerminalControls("a\x1b[1;8msecret\x1b[0mb").text).toBe("ab");
    expect(stripTerminalControls("more\x1b[28mb", true).text).toBe("b");
    expect(stripTerminalControls("\x1b[38;5;8mgrey\x1b[38:5:8mtoo").text).toBe("greytoo");
  });

  it("carries a sequence cut off at the end of a chunk", () => {
    expect(stripTerminalControls("a\x1b[3")).toMatchObject({ text: "a", pending: "\x1b[3" });
    expect(stripTerminalControls("a\x1b]0;title\x1b")).toMatchObject({
      text: "a",
      pending: "\x1b]0;title\x1b",
    });
    expect(stripTerminalControls("\x1b]0;title\x1b\\b")).toMatchObject({ text: "b", pending: "" });
  });
});

describe("accessibleRowText", () => {
  it("blanks concealed cells the canvas does not draw", () => {
    const cells = [..."ab"].map((text, index) => ({ text, invisible: index === 0 }));
    const row = { cells, text: "ab" } as unknown as Parameters<typeof accessibleRowText>[0];
    expect(accessibleRowText(row)).toBe(" b");
  });
});

describe("collapseTerminalOverwrites", () => {
  it("keeps the last visible text of each rewritten line", () => {
    expect(collapseTerminalOverwrites("10%\r50%\r100%\r\ndone\r\n")).toBe("100%\ndone\n");
  });
});

describe("TerminalAnnouncer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createAnnouncer() {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("document", {
      createElement: () => ({ className: "", textContent: "", setAttribute() {} }),
    });
    return new TerminalAnnouncer();
  }

  it("skips the echo of typed characters and reads the rest", () => {
    const announcer = createAnnouncer();
    announcer.typed("l");
    announcer.typed("s");
    announcer.output("ls", false);
    announcer.typed("\r");
    announcer.output("\r\nREADME.md\r\n", false);
    vi.runAllTimers();
    expect(announcer.element.textContent).toBe("\nREADME.md\n");
  });

  it("still skips the echo when the shell redraws the line first", () => {
    const announcer = createAnnouncer();
    announcer.typed("a");
    announcer.output("\r$ a", false);
    vi.runAllTimers();
    expect(announcer.element.textContent).toBe("$ ");
  });

  it("clears the region between batches and on reset", () => {
    const announcer = createAnnouncer();
    announcer.output("compiled\n", false);
    vi.runAllTimers();
    expect(announcer.element.textContent).toBe("compiled\n");

    // An identical batch must pass through an empty region to be announced again.
    announcer.output("compiled\n", false);
    expect(announcer.element.textContent).toBe("");
    vi.runAllTimers();
    expect(announcer.element.textContent).toBe("compiled\n");

    announcer.reset();
    expect(announcer.element.textContent).toBe("");
  });

  it("starts each chunk from the terminal's conceal state", () => {
    const announcer = createAnnouncer();
    announcer.output("secret\x1b[28mshown", true);
    vi.runAllTimers();
    expect(announcer.element.textContent).toBe("shown");
  });

  it("completes a conceal sequence split across output it did not announce", () => {
    const announcer = createAnnouncer();
    // The core holds the unfinished sequence, so its style is not concealed yet.
    announcer.skip("unfocused\x1b[");
    announcer.reset();
    announcer.output("8msecret", false);
    announcer.replay("history\x1b[1;");
    announcer.output("8mhidden", false);
    vi.runAllTimers();
    expect(announcer.element.textContent).toBe("");
  });

  it("keeps an open string sequence across skipped output with a stray ESC", () => {
    const announcer = createAnnouncer();
    announcer.skip("\x1b]0;ti");
    announcer.skip("tle\x1b");
    announcer.output("xVISIBLE\x1b\\", false);
    vi.runAllTimers();
    expect(announcer.element.textContent).toBe("");
  });

  it("stops reading long output until the next keystroke", () => {
    const announcer = createAnnouncer();
    announcer.output("line\n".repeat(30), false);
    vi.runAllTimers();
    expect(announcer.element.textContent.match(/line/g)).toHaveLength(21);
    expect(announcer.element.textContent).toContain("Too much output");

    announcer.output("more\n", false);
    vi.runAllTimers();
    expect(announcer.element.textContent).toContain("Too much output");

    announcer.typed("\r");
    announcer.output("next\n", false);
    vi.runAllTimers();
    expect(announcer.element.textContent).toBe("next\n");
  });
});
