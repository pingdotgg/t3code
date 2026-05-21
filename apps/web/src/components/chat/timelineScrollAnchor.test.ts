import type { LegendListRef } from "@legendapp/list/react";
import { describe, expect, it, vi } from "vitest";
import {
  captureTimelineScrollAnchor,
  restoreTimelineScrollAnchor,
  scheduleTimelineScrollAnchorRestore,
} from "./timelineScrollAnchor";

function makeRect(top: number, bottom: number): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function makeRow(id: string, top: number, bottom: number): HTMLElement {
  return {
    dataset: { timelineRowId: id },
    getBoundingClientRect: () => makeRect(top, bottom),
  } as unknown as HTMLElement;
}

function makeListRef(rows: HTMLElement[], scrollTop = 0): LegendListRef {
  const scrollableNode = {
    scrollTop,
    getBoundingClientRect: () => makeRect(0, 100),
    querySelectorAll: () => rows,
  } as unknown as HTMLElement;

  return {
    getScrollableNode: () => scrollableNode,
  } as unknown as LegendListRef;
}

describe("timeline scroll anchor", () => {
  it("captures the first visible timeline row and its offset", () => {
    const listRef = makeListRef([
      makeRow("before", -80, -20),
      makeRow("anchor", -30, 30),
      makeRow("after", 30, 90),
    ]);

    expect(captureTimelineScrollAnchor(listRef)).toEqual({
      rowId: "anchor",
      offsetTop: -30,
    });
  });

  it("restores by the anchor row position delta", () => {
    const listRef = makeListRef([makeRow("anchor", 80, 140)], 200);

    expect(restoreTimelineScrollAnchor(listRef, { rowId: "anchor", offsetTop: -30 })).toBe(true);
    expect(listRef.getScrollableNode().scrollTop).toBe(310);
  });

  it("cancels scheduled restoration when the user scroll token changes", () => {
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const setTimeout = vi.fn(() => 1);
    const clearTimeout = vi.fn();
    const listRef = { current: makeListRef([makeRow("anchor", 80, 140)], 200) };

    scheduleTimelineScrollAnchorRestore({
      listRef,
      anchor: { rowId: "anchor", offsetTop: -30 },
      shouldCancel: () => true,
      scheduler: {
        requestAnimationFrame,
        cancelAnimationFrame: vi.fn(),
        setTimeout,
        clearTimeout,
      },
    });

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
    expect(listRef.current.getScrollableNode().scrollTop).toBe(200);
    expect(clearTimeout).not.toHaveBeenCalled();
  });
});
