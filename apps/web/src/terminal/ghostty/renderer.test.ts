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
      width: 7,
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
});

describe("renderGhosttySnapshot", () => {
  it("remaps terminal defaults without overriding explicit application colors", () => {
    const fillRectCalls: Array<{ args: number[]; style: string }> = [];
    const fillTextCalls: Array<{ args: unknown[]; style: string }> = [];
    let fillStyle = "";
    const context = {
      canvas: { width: 200, height: 40 },
      beginPath: () => {},
      clip: () => {},
      fillRect: (...args: number[]) => fillRectCalls.push({ args, style: fillStyle }),
      fillText: (...args: unknown[]) => fillTextCalls.push({ args, style: fillStyle }),
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        fillStyle = String(value);
      },
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const defaultCell = cell("a");
    const inverseCell = {
      ...cell("i"),
      foreground: defaultCell.background,
      background: defaultCell.foreground,
    };
    const applicationCell = {
      ...cell("b"),
      foreground: { r: 10, g: 20, b: 30 },
      background: { r: 40, g: 50, b: 60 },
    };
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 1,
      foreground: defaultCell.foreground,
      background: defaultCell.background,
      cursor: { r: 9, g: 8, b: 7 },
      cursorX: 0,
      cursorY: 0,
      cursorVisible: true,
      cursorBlinking: false,
      cursorStyle: 0,
      dirtyRows: new Set([0]),
      rowData: [
        {
          cells: [defaultCell, inverseCell, applicationCell],
          text: "aib",
          isWrapContinuation: false,
          wrapsToNext: false,
        },
      ],
    };

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 10, height: 20, baseline: 15 },
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: true,
      cursorOn: true,
      defaultThemeOverride: {
        source: {
          background: defaultCell.background,
          foreground: defaultCell.foreground,
          cursor: defaultCell.foreground,
        },
        target: {
          background: { r: 1, g: 2, b: 3 },
          foreground: { r: 250, g: 251, b: 252 },
          cursor: { r: 200, g: 201, b: 202 },
        },
      },
    });

    expect(fillRectCalls).toContainEqual({
      args: [0, 0, 200, 40],
      style: "rgb(1, 2, 3)",
    });
    expect(fillRectCalls).toContainEqual({
      args: [14, 4, 10, 20],
      style: "rgb(250, 251, 252)",
    });
    expect(fillRectCalls).toContainEqual({
      args: [24, 4, 10, 20],
      style: "rgb(40, 50, 60)",
    });
    expect(fillRectCalls).toContainEqual({
      args: [4, 4, 2, 20],
      style: "rgb(9, 8, 7)",
    });
    expect(fillTextCalls).toEqual([
      { args: ["a", 4, 19, 10], style: "rgb(250, 251, 252)" },
      { args: ["i", 14, 19, 10], style: "rgb(1, 2, 3)" },
      { args: ["b", 24, 19, 10], style: "rgb(10, 20, 30)" },
    ]);
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

  it("draws solid block elements to exact cell edges", () => {
    const fillRectCalls: Array<{ args: number[]; style: string }> = [];
    let fillStyle = "";
    const context = {
      canvas: { width: 100, height: 40 },
      beginPath: () => {},
      clip: () => {},
      fillRect: (...args: number[]) => fillRectCalls.push({ args, style: fillStyle }),
      fillText: () => {},
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        fillStyle = String(value);
      },
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: -1,
      cursorY: -1,
      cursorVisible: false,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [
        {
          cells: [cell("▀"), cell("▄"), cell("█")],
          text: "▀▄█",
          isWrapContinuation: false,
          wrapsToNext: false,
        },
      ],
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
    });

    expect(fillRectCalls).toContainEqual({ args: [4, 4, 10, 10], style: "rgb(255, 255, 255)" });
    expect(fillRectCalls).toContainEqual({
      args: [14, 14, 10, 10],
      style: "rgb(255, 255, 255)",
    });
    expect(fillRectCalls).toContainEqual({
      args: [24, 4, 10, 20],
      style: "rgb(255, 255, 255)",
    });
  });

  it("keeps one-eighth block edges at least one pixel wide in narrow cells", () => {
    const fillRectCalls: number[][] = [];
    const context = {
      canvas: { width: 100, height: 40 },
      beginPath: () => {},
      clip: () => {},
      fillRect: (...args: number[]) => fillRectCalls.push(args),
      fillText: () => {},
      rect: () => {},
      resetTransform: () => {},
      restore: () => {},
      save: () => {},
      set fillStyle(_value: string | CanvasGradient | CanvasPattern) {},
      set font(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
    const snapshot: GhosttySnapshot = {
      cols: 2,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: -1,
      cursorY: -1,
      cursorVisible: false,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [
        {
          cells: [cell("▏"), cell("▕")],
          text: "▏▕",
          isWrapContinuation: false,
          wrapsToNext: false,
        },
      ],
    };

    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 4, height: 20, baseline: 15 },
      fontSize: 7,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: false,
    });

    // Rounding 7/8 of a 4px cell would collapse the right bar to nothing.
    expect(fillRectCalls).toContainEqual([4, 4, 1, 20]);
    expect(fillRectCalls).toContainEqual([11, 4, 1, 20]);
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
