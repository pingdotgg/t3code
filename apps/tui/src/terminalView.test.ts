import * as NodeModule from "node:module";

import { RGBA } from "@opentui/core";
import { describe, expect, it } from "bun:test";

import {
  encodeTerminalPaste,
  readTerminalFrame,
  readTerminalViewport,
  type TermSegment,
} from "./terminalView.ts";

const { Terminal } = NodeModule.createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");

/** Write to a fresh headless terminal and read its first row of segments. */
function firstRow(data: string): Promise<ReadonlyArray<TermSegment>> {
  const term = new Terminal({ cols: 40, rows: 2, allowProposedApi: true });
  return new Promise((resolve) => {
    term.write(data, () => resolve(readTerminalFrame(term).rows[0] ?? []));
  });
}

const isRGBA = (c: TermSegment["color"]): c is RGBA => c instanceof RGBA;

describe("readTerminalFrame colours", () => {
  it("Given an ANSI palette colour, then it emits an indexed RGBA at that slot (themed by the terminal)", async () => {
    const segments = await firstRow("\x1b[31mred\x1b[0m");
    const seg = segments.find((s) => s.text.includes("red"));
    expect(seg).toBeDefined();
    expect(isRGBA(seg!.color)).toBe(true);
    expect((seg!.color as RGBA).intent).toBe("indexed");
    expect((seg!.color as RGBA).slot).toBe(1);
  });

  it("Given a truecolor cell, then it passes through as a hex string", async () => {
    const segments = await firstRow("\x1b[38;2;10;20;30mtru\x1b[0m");
    const seg = segments.find((s) => s.text.includes("tru"));
    expect(seg?.color).toBe("#0a141e");
  });

  it("Given default-coloured text, then no explicit colour is set (inherits the terminal default)", async () => {
    const segments = await firstRow("plain");
    const seg = segments.find((s) => s.text.includes("plain"));
    expect(seg?.color).toBeUndefined();
  });
});

describe("readTerminalViewport", () => {
  it("Given written rows, then it returns the on-screen text without trailing blanks", async () => {
    const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
    const text = await new Promise<string>((resolve) => {
      term.write("first line\r\nsecond line\r\n", () => resolve(readTerminalViewport(term)));
    });
    expect(text).toBe("first line\nsecond line");
  });
});

describe("readTerminalFrame scrollback", () => {
  it("Given more output than rows, when scrolled up, then it renders older lines and hides the cursor", async () => {
    const term = new Terminal({ cols: 20, rows: 3, allowProposedApi: true, scrollback: 100 });
    await new Promise<void>((resolve) => {
      term.write("L1\r\nL2\r\nL3\r\nL4\r\nL5\r\n", () => resolve());
    });
    const tail = readTerminalFrame(term);
    expect(tail.scrollOffset).toBe(0);
    expect(tail.maxScroll).toBeGreaterThan(0);

    const scrolled = readTerminalFrame(term, 2);
    expect(scrolled.scrollOffset).toBe(2);
    // Cursor is suppressed while viewing history.
    expect(scrolled.cursor).toEqual({ x: -1, y: -1 });
    // The top visible row is older than the tail's top row.
    const topText = (scrolled.rows[0] ?? []).map((seg) => seg.text).join("");
    expect(topText).toContain("L");
  });

  it("Given an offset past the scrollback, then it clamps to maxScroll", async () => {
    const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true, scrollback: 100 });
    await new Promise<void>((resolve) => {
      term.write("A\r\nB\r\nC\r\n", () => resolve());
    });
    const frame = readTerminalFrame(term, 9999);
    expect(frame.scrollOffset).toBe(frame.maxScroll);
  });
});

describe("encodeTerminalPaste (bracketed-paste injection guard)", () => {
  it("Given bracketed paste off, then the text is forwarded verbatim", () => {
    expect(encodeTerminalPaste("echo hi\n", false)).toBe("echo hi\n");
  });

  it("Given bracketed paste on, then it frames with the real CSI 200~/201~ introducers", () => {
    expect(encodeTerminalPaste("hello", true)).toBe("\x1b[200~hello\x1b[201~");
  });

  it("Given a payload with an embedded end marker, then it is stripped so paste can't break out", () => {
    // A crafted clipboard trying to close paste mode early and run `rm -rf ~`.
    const malicious = "safe\x1b[201~rm -rf ~\n";
    const encoded = encodeTerminalPaste(malicious, true);
    // Exactly one start and one (trailing) end marker survive — no interior one.
    expect(encoded).toBe("\x1b[200~saferm -rf ~\n\x1b[201~");
    expect(encoded.indexOf("\x1b[201~")).toBe(encoded.length - "\x1b[201~".length);
  });

  it("Given the 8-bit C1 end-marker form, then it is stripped too", () => {
    const encoded = encodeTerminalPaste("a\x9b201~b", true);
    expect(encoded).toBe("\x1b[200~ab\x1b[201~");
  });
});
