import { describe, expect, it } from "vitest";

import {
  resolveRenderedDrawerHeight,
  resolveTerminalCellFromPoint,
  resolveTerminalSelectionActionPosition,
  resolveTerminalKeyboardViewport,
  resolveTerminalTouchSelectionRange,
  resolveTerminalTouchScroll,
  resolveTerminalWordRange,
  selectPendingTerminalEventEntries,
  selectTerminalEventEntriesAfterSnapshot,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./ThreadTerminalDrawer";

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });

  it("replays only terminal events newer than the open snapshot", () => {
    expect(
      selectTerminalEventEntriesAfterSnapshot(
        [
          {
            id: 1,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:00.000Z",
              type: "output",
              data: "before",
            },
          },
          {
            id: 2,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:01.000Z",
              type: "output",
              data: "after",
            },
          },
        ],
        "2026-04-02T20:00:00.500Z",
      ).map((entry) => entry.id),
    ).toEqual([2]);
  });

  it("applies only terminal events that have not already been consumed", () => {
    expect(
      selectPendingTerminalEventEntries(
        [
          {
            id: 1,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:00.000Z",
              type: "output",
              data: "one",
            },
          },
          {
            id: 2,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:01.000Z",
              type: "output",
              data: "two",
            },
          },
        ],
        1,
      ).map((entry) => entry.id),
    ).toEqual([2]);
  });
});

describe("resolveTerminalKeyboardViewport", () => {
  it("returns the keyboard overlap when the visual viewport is covered from the bottom", () => {
    expect(
      resolveTerminalKeyboardViewport({
        layoutViewportHeight: 800,
        visualViewportHeight: 500,
        visualViewportOffsetTop: 0,
      }),
    ).toEqual({
      bottomInset: 300,
      visibleHeight: 500,
    });
  });

  it("accounts for visual viewport top offset", () => {
    expect(
      resolveTerminalKeyboardViewport({
        layoutViewportHeight: 800,
        visualViewportHeight: 500,
        visualViewportOffsetTop: 40,
      }),
    ).toEqual({
      bottomInset: 260,
      visibleHeight: 500,
    });
  });

  it("ignores small viewport differences that are unlikely to be the keyboard", () => {
    expect(
      resolveTerminalKeyboardViewport({
        layoutViewportHeight: 800,
        visualViewportHeight: 740,
        visualViewportOffsetTop: 0,
      }),
    ).toEqual({
      bottomInset: 0,
      visibleHeight: null,
    });
  });

  it("caps the rendered drawer height while the keyboard is visible without changing stored height", () => {
    expect(
      resolveRenderedDrawerHeight(500, {
        bottomInset: 300,
        visibleHeight: 400,
      }),
    ).toBe(300);

    expect(
      resolveRenderedDrawerHeight(500, {
        bottomInset: 0,
        visibleHeight: null,
      }),
    ).toBe(500);
  });
});

describe("resolveTerminalTouchScroll", () => {
  it("converts accumulated touch pixels into whole terminal rows", () => {
    expect(resolveTerminalTouchScroll({ accumulatedPixels: 32, rowHeight: 14 })).toEqual({
      lines: 2,
      remainingPixels: 4,
    });
  });

  it("preserves partial negative scroll pixels", () => {
    expect(resolveTerminalTouchScroll({ accumulatedPixels: -31, rowHeight: 14 })).toEqual({
      lines: -2,
      remainingPixels: -3,
    });
  });

  it("waits until a full row has accumulated", () => {
    expect(resolveTerminalTouchScroll({ accumulatedPixels: 6, rowHeight: 14 })).toEqual({
      lines: 0,
      remainingPixels: 6,
    });
  });
});

describe("resolveTerminalCellFromPoint", () => {
  it("converts a viewport point into a buffer cell", () => {
    expect(
      resolveTerminalCellFromPoint({
        bounds: { left: 100, top: 50, width: 800, height: 240 },
        clientX: 185,
        clientY: 82,
        cols: 80,
        rows: 24,
        viewportY: 12,
      }),
    ).toEqual({ column: 8, row: 15 });
  });

  it("clamps points into the terminal viewport and applies viewportY", () => {
    expect(
      resolveTerminalCellFromPoint({
        bounds: { left: 100, top: 50, width: 800, height: 240 },
        clientX: 20,
        clientY: 10,
        cols: 80,
        rows: 24,
        viewportY: 7,
      }),
    ).toEqual({ column: 0, row: 7 });

    expect(
      resolveTerminalCellFromPoint({
        bounds: { left: 100, top: 50, width: 800, height: 240 },
        clientX: 980,
        clientY: 340,
        cols: 80,
        rows: 24,
        viewportY: 7,
      }),
    ).toEqual({ column: 79, row: 30 });
  });

  it("returns null for invalid terminal geometry", () => {
    expect(
      resolveTerminalCellFromPoint({
        bounds: { left: 0, top: 0, width: 0, height: 240 },
        clientX: 0,
        clientY: 0,
        cols: 80,
        rows: 24,
        viewportY: 0,
      }),
    ).toBeNull();
  });
});

describe("resolveTerminalTouchSelectionRange", () => {
  it("keeps the original word selected when dragging inside it", () => {
    expect(
      resolveTerminalTouchSelectionRange({
        cols: 80,
        currentCell: { column: 8, row: 3 },
        wordEndExclusive: { column: 12, row: 3 },
        wordStart: { column: 6, row: 3 },
      }),
    ).toEqual({ column: 6, row: 3, length: 6 });
  });

  it("extends forward through the current cell", () => {
    expect(
      resolveTerminalTouchSelectionRange({
        cols: 80,
        currentCell: { column: 4, row: 4 },
        wordEndExclusive: { column: 12, row: 3 },
        wordStart: { column: 6, row: 3 },
      }),
    ).toEqual({ column: 6, row: 3, length: 79 });
  });

  it("extends backward from the current cell through the original word", () => {
    expect(
      resolveTerminalTouchSelectionRange({
        cols: 80,
        currentCell: { column: 2, row: 3 },
        wordEndExclusive: { column: 12, row: 3 },
        wordStart: { column: 6, row: 3 },
      }),
    ).toEqual({ column: 2, row: 3, length: 10 });
  });
});

describe("resolveTerminalWordRange", () => {
  it("selects the whole non-separator group around the column", () => {
    const line = "  git commit --amend  ";
    // Column inside "commit".
    expect(resolveTerminalWordRange(line, 8)).toEqual({ start: 6, length: 6 });
  });

  it("keeps a path or URL together as one group", () => {
    const line = "open https://example.com/a-b_c";
    expect(resolveTerminalWordRange(line, 10)).toEqual({ start: 5, length: 25 });
  });

  it("returns null when the column sits on whitespace", () => {
    expect(resolveTerminalWordRange("ls  -la", 2)).toBeNull();
  });

  it("returns null for blank or padded-out cells", () => {
    expect(resolveTerminalWordRange("hi        ", 5)).toBeNull();
  });

  it("breaks on xterm's separator characters like a double-press", () => {
    const line = "arr[index]";
    // Column on "index" stops at the surrounding brackets.
    expect(resolveTerminalWordRange(line, 5)).toEqual({ start: 4, length: 5 });
    // Column on "arr" stops before "[".
    expect(resolveTerminalWordRange(line, 1)).toEqual({ start: 0, length: 3 });
  });

  it("returns null for out-of-range columns", () => {
    expect(resolveTerminalWordRange("abc", -1)).toBeNull();
    expect(resolveTerminalWordRange("abc", 3)).toBeNull();
  });
});
