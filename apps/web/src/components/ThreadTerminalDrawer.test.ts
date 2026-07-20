import { describe, expect, it } from "vite-plus/test";

import {
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
  writePreservingScrollback,
} from "./ThreadTerminalDrawer";

describe("writePreservingScrollback", () => {
  it("restores a scrolled-back viewport with a relative scroll delta", () => {
    let scrollbackLength = 100;
    const writes: Array<string> = [];
    const scrollDeltas: Array<number> = [];
    const terminal = {
      getScrollbackLength: () => scrollbackLength,
      getViewportY: () => 20,
      scrollLines: (amount: number) => scrollDeltas.push(amount),
      write: (data: string) => {
        writes.push(data);
        scrollbackLength = 103;
      },
    };

    writePreservingScrollback(terminal, "one\ntwo\nthree\n");

    expect(writes).toEqual(["one\ntwo\nthree\n"]);
    expect(scrollDeltas).toEqual([-23]);
  });

  it("accounts for evicted lines when scrollback is already capped", () => {
    const scrollDeltas: Array<number> = [];
    const terminal = {
      getScrollbackLength: () => 5_000,
      getViewportY: () => 20,
      scrollLines: (amount: number) => scrollDeltas.push(amount),
      write: (_data: string) => undefined,
    };

    writePreservingScrollback(terminal, "one\ntwo\n");

    expect(scrollDeltas).toEqual([-22]);
  });
});

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
});
