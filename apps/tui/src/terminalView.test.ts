import { createRequire } from "node:module";

import { RGBA } from "@opentui/core";
import { describe, expect, it } from "bun:test";

import { readTerminalFrame, type TermSegment } from "./terminalView.ts";

const { Terminal } = createRequire(import.meta.url)(
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
