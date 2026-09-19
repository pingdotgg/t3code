import { describe, expect, it } from "vite-plus/test";

import { GHOSTTY_CELL_WIDE, type GhosttyCell, type GhosttySnapshot } from "./core";
import {
  ghosttyTextRunEnd,
  measureGhosttyCell,
  renderGhosttySnapshot,
  terminalGridSize,
} from "./renderer";

const cell = (text: string, wide = 0): GhosttyCell => ({
  text,
  wide,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
});

const WHITE = "rgb(255, 255, 255)";
const BLACK = "rgb(0, 0, 0)";

/** Canvas stub that records fillRect calls per fill style and every fillText call. */
function recordingContext() {
  const rects = new Map<string, number[][]>();
  const fillTextCalls: unknown[][] = [];
  let fillStyle = "";
  const context = {
    canvas: { width: 200, height: 80 },
    beginPath: () => {},
    clip: () => {},
    fillRect: (...args: number[]) => {
      rects.set(fillStyle, [...(rects.get(fillStyle) ?? []), args]);
    },
    fillText: (...args: unknown[]) => fillTextCalls.push(args),
    rect: () => {},
    resetTransform: () => {},
    restore: () => {},
    save: () => {},
    set fillStyle(value: string) {
      fillStyle = value;
    },
    set font(_value: string) {},
    set textBaseline(_value: string) {},
  } as unknown as CanvasRenderingContext2D;
  return {
    context,
    fillTextCalls,
    rectsFilledWith: (style: string) => rects.get(style) ?? [],
  };
}

/** White-on-black snapshot of the given rows, every row dirty, one cell per character. */
function textSnapshot(rows: readonly string[], cursor?: { x: number; y: number }): GhosttySnapshot {
  return {
    cols: Math.max(...rows.map((row) => row.length)),
    rows: rows.length,
    foreground: { r: 255, g: 255, b: 255 },
    background: { r: 0, g: 0, b: 0 },
    cursor: { r: 255, g: 255, b: 255 },
    cursorX: cursor?.x ?? -1,
    cursorY: cursor?.y ?? -1,
    cursorVisible: cursor !== undefined,
    cursorBlinking: false,
    cursorStyle: 1,
    dirtyRows: new Set(rows.map((_, index) => index)),
    rowData: rows.map((text) => ({
      cells: Array.from(text, (char) => cell(char)),
      text,
      isWrapContinuation: false,
      wrapsToNext: false,
    })),
  };
}

const RENDER_OPTIONS = { fontSize: 12, fontFamily: "monospace", padding: 4, forceFull: false };

describe("terminalGridSize", () => {
  it("matches the mobile renderer's cell-and-padding sizing model", () => {
    expect(terminalGridSize(808, 408, { width: 10, height: 20, baseline: 15 }, 4)).toEqual({
      cols: 80,
      rows: 20,
    });
  });

  it("never sends an invalid zero-sized terminal to libghostty", () => {
    expect(terminalGridSize(0, 0, { width: 10, height: 20, baseline: 15 }, 4)).toEqual({
      cols: 1,
      rows: 1,
    });
  });
});

describe("measureGhosttyCell", () => {
  it("uses descender-aware metrics and the mobile terminal line-height", () => {
    const measureText = (text: string) =>
      text === "M"
        ? { width: 7.2, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 0 }
        : { width: 14.4, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 };
    const context = {
      font: "",
      measureText,
    } as unknown as CanvasRenderingContext2D;

    expect(measureGhosttyCell(context, 12, "monospace")).toEqual({
      width: 7.2,
      height: 16,
      baseline: 11,
    });
  });
});

describe("ghosttyTextRunEnd", () => {
  it("includes wide spacer tails in the visual clip without rendering spaces", () => {
    const cells = [
      cell("界", GHOSTTY_CELL_WIDE.wide),
      cell("", GHOSTTY_CELL_WIDE.spacerTail),
      cell("🙂", GHOSTTY_CELL_WIDE.wide),
      cell("", GHOSTTY_CELL_WIDE.spacerTail),
      cell(""),
    ];
    expect(ghosttyTextRunEnd(cells, 0, () => true)).toBe(4);
  });

  it("stops before a block element so it never enters a font text run", () => {
    expect(ghosttyTextRunEnd([cell("a"), cell("\u2588"), cell("b")], 0, () => true)).toBe(1);
  });
});

describe("renderGhosttySnapshot", () => {
  it("fills block elements edge to edge so stacked rows leave no stripe", () => {
    const { context, fillTextCalls, rectsFilledWith } = recordingContext();

    renderGhosttySnapshot({
      ...RENDER_OPTIONS,
      context,
      // The half blocks qrcode-terminal emits for Expo QR codes, plus a
      // quadrant so the merged-rectangle table is exercised.
      snapshot: textSnapshot(["\u2580\u2584\u2588", "\u2588 \u2599"]),
      metrics: { width: 10, height: 20, baseline: 15 },
      cursorOn: false,
    });

    expect(rectsFilledWith(WHITE)).toEqual([
      [4, 4, 10, 10],
      [14, 14, 10, 10],
      [24, 4, 10, 20],
      [4, 24, 10, 20],
      [24, 24, 5, 20],
      [29, 34, 5, 10],
    ]);
    expect(fillTextCalls).toEqual([]);
  });

  it("keeps a sub-pixel eighth block inside its own cell", () => {
    const { context, rectsFilledWith } = recordingContext();

    renderGhosttySnapshot({
      ...RENDER_OPTIONS,
      context,
      snapshot: textSnapshot([" \u2595"]),
      // The right eighth of the second cell spans 17.5..18.4, which rounds to
      // nothing; it must land on 17..18 rather than spill into column three.
      metrics: { width: 7.2, height: 16, baseline: 11 },
      cursorOn: false,
    });

    expect(rectsFilledWith(WHITE)).toEqual([[17, 4, 1, 16]]);
  });

  it("keeps block geometry when a block cursor inverts the cell", () => {
    const { context, fillTextCalls, rectsFilledWith } = recordingContext();

    renderGhosttySnapshot({
      ...RENDER_OPTIONS,
      context,
      snapshot: textSnapshot(["\u2584"], { x: 0, y: 0 }),
      metrics: { width: 10, height: 20, baseline: 15 },
      cursorOn: true,
    });

    // The row clear comes first; the inverted lower half block follows it.
    expect(rectsFilledWith(BLACK)).toEqual([
      [4, 4, 10, 20],
      [4, 14, 10, 10],
    ]);
    expect(fillTextCalls).toEqual([]);
  });

  it("underlines every cell in a hovered wrapped link", () => {
    const fillRectCalls: number[][] = [];
    const context = {
      canvas: { width: 200, height: 80 },
      beginPath: () => {},
      clip: () => {},
      fillRect: (...args: number[]) => fillRectCalls.push(args),
      fillText: () => {},
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const snapshot: GhosttySnapshot = {
      cols: 4,
      rows: 2,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: -1,
      cursorY: -1,
      cursorVisible: false,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0, 1]),
      rowData: [0, 1].map(() => ({
        cells: [cell("a"), cell("b"), cell("c"), cell("d")],
        text: "abcd",
        isWrapContinuation: false,
        wrapsToNext: false,
      })),
    };

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 10, height: 20, baseline: 15 },
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: false,
      hoveredLinkRange: { start: { x: 2, y: 0 }, end: { x: 1, y: 1 } },
    });

    expect(fillRectCalls.filter(([, , , height]) => height === 1)).toEqual([
      [24, 22, 10, 1],
      [34, 22, 10, 1],
      [4, 42, 10, 1],
      [14, 42, 10, 1],
    ]);
  });

  it("constrains text runs and cursor glyphs to their terminal cells", () => {
    const fillTextCalls: unknown[][] = [];
    const context = {
      canvas: { width: 200, height: 40 },
      beginPath: () => {},
      clip: () => {},
      fillRect: () => {},
      fillText: (...args: unknown[]) => fillTextCalls.push(args),
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const cells = [cell("a"), cell("b"), cell("x")];
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: 2,
      cursorY: 0,
      cursorVisible: true,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [{ cells, text: "abx", isWrapContinuation: false, wrapsToNext: false }],
    };

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 7.2, height: 16, baseline: 11 },
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: true,
    });

    expect(fillTextCalls).toEqual([
      ["abx", 4, 15, 21.6],
      ["x", 18.4, 15, 7.2],
    ]);
  });

  it("repaints the cell without an overlay during the blink off phase", () => {
    const fillTextCalls: unknown[][] = [];
    const context = {
      canvas: { width: 200, height: 40 },
      beginPath: () => {},
      clip: () => {},
      fillRect: () => {},
      fillText: (...args: unknown[]) => fillTextCalls.push(args),
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: 2,
      cursorY: 0,
      cursorVisible: true,
      cursorBlinking: true,
      cursorStyle: 1,
      dirtyRows: new Set(),
      rowData: [
        {
          cells: [cell("a"), cell("b"), cell("x")],
          text: "abx",
          isWrapContinuation: false,
          wrapsToNext: false,
        },
      ],
    };

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 7.2, height: 16, baseline: 11 },
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: false,
    });

    // The cursor row still repaints so the block disappears, but the inverted
    // glyph the on phase draws over the cell is gone.
    expect(fillTextCalls).toEqual([["abx", 4, 15, 21.6]]);
  });

  it("repaints the previous cursor row after the cursor moves", () => {
    const clearedRows: number[] = [];
    const context = {
      canvas: { width: 200, height: 80 },
      beginPath: () => {},
      clip: () => {},
      fillRect: (_left: number, top: number, _width: number, height: number) => {
        if (height === 16) clearedRows.push(top);
      },
      fillText: () => {},
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const snapshot: GhosttySnapshot = {
      cols: 1,
      rows: 3,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: 0,
      cursorY: 2,
      cursorVisible: true,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set(),
      rowData: [0, 1, 2].map(() => ({
        cells: [cell("")],
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      })),
    };

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 7.2, height: 16, baseline: 11 },
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: true,
      previousCursorY: 0,
    });

    expect(clearedRows).toEqual([4, 36, 36]);
  });
});
