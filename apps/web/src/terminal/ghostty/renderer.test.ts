import { describe, expect, it } from "vite-plus/test";

import { GHOSTTY_CELL_WIDE, type GhosttyCell, type GhosttySnapshot } from "./core";
import { renderGhosttySnapshot } from "./renderer";

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };
const METRICS = { width: 8, height: 20, baseline: 15 };

function cell(text: string): GhosttyCell {
  return {
    text,
    wide: GHOSTTY_CELL_WIDE.narrow,
    foreground: WHITE,
    background: BLACK,
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: false,
    selected: false,
  };
}

function render(text: string) {
  const calls: Array<{ readonly op: string; readonly args: readonly unknown[] }> = [];
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
    };
  const context = {
    canvas: { width: 100, height: 100 },
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textBaseline: "",
    save: record("save"),
    restore: record("restore"),
    resetTransform: record("resetTransform"),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    ellipse: record("ellipse"),
    closePath: record("closePath"),
    fill: record("fill"),
    rect: record("rect"),
    clip: record("clip"),
    fillText: record("fillText"),
  } as unknown as CanvasRenderingContext2D;
  const snapshot: GhosttySnapshot = {
    cols: 1,
    rows: 1,
    foreground: WHITE,
    background: BLACK,
    cursor: WHITE,
    cursorX: -1,
    cursorY: -1,
    cursorVisible: false,
    cursorBlinking: false,
    cursorStyle: 1,
    dirtyRows: new Set([0]),
    rowData: [{ cells: [cell(text)], text, isWrapContinuation: false, wrapsToNext: false }],
  };
  renderGhosttySnapshot({
    context,
    snapshot,
    metrics: METRICS,
    fontSize: 14,
    fontFamily: "monospace",
    padding: 0,
    forceFull: false,
    cursorOn: false,
  });
  return calls;
}

describe("renderGhosttySnapshot powerline separators", () => {
  it("fills the right half-circle cap from the cell's left edge across its full height", () => {
    const calls = render("");
    expect(calls.some((call) => call.op === "fillText")).toBe(false);
    expect(calls.find((call) => call.op === "ellipse")?.args).toEqual([
      0,
      10,
      8,
      10,
      0,
      -Math.PI / 2,
      Math.PI / 2,
    ]);
  });

  it("fills the left half-circle cap from the cell's right edge across its full height", () => {
    const calls = render("");
    expect(calls.some((call) => call.op === "fillText")).toBe(false);
    expect(calls.find((call) => call.op === "ellipse")?.args).toEqual([
      8,
      10,
      8,
      10,
      0,
      Math.PI / 2,
      (3 * Math.PI) / 2,
    ]);
  });

  it("still draws other private-use glyphs from the font", () => {
    const calls = render("");
    expect(calls.some((call) => call.op === "ellipse")).toBe(false);
    expect(calls.some((call) => call.op === "fillText")).toBe(true);
  });
});
