import { act, createElement, useLayoutEffect, type PointerEvent } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  exceedsMoveTolerance,
  LONG_PRESS_MOVE_TOLERANCE,
  LONG_PRESS_MS,
  useLongPress,
} from "./useLongPress";

describe("exceedsMoveTolerance", () => {
  const start = { x: 100, y: 100 };

  it("keeps the gesture alive for the small drift of a stationary finger", () => {
    expect(exceedsMoveTolerance(start, { x: 103, y: 104 })).toBe(false);
  });

  it("measures diagonal drift rather than either axis alone", () => {
    // 5px on each axis stays inside a per-axis check but is ~7.1px of travel.
    expect(exceedsMoveTolerance(start, { x: 105, y: 105 })).toBe(true);
  });

  it("treats travel exactly at the tolerance as still pressing", () => {
    expect(exceedsMoveTolerance(start, { x: 100 + LONG_PRESS_MOVE_TOLERANCE, y: 100 })).toBe(false);
  });

  it("releases the gesture to the scroll once the finger travels", () => {
    expect(exceedsMoveTolerance(start, { x: 100, y: 140 })).toBe(true);
  });
});

describe("long press while starting a drag", () => {
  let renderer: ReactTestRenderer;
  let handlers: ReturnType<typeof useLongPress>;
  const openMenu = vi.fn();

  function Row() {
    const longPress = useLongPress(openMenu);
    useLayoutEffect(() => {
      handlers = longPress;
    });
    return null;
  }

  function touch(clientX: number) {
    return { pointerType: "touch", clientX, clientY: 100, target: null } as unknown as PointerEvent;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("Element", EventTarget);
    await act(() => {
      renderer = create(createElement(Row));
    });
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([7, 8, 10])("does not open the menu after moving %ipx and holding", async (distance) => {
    await act(() => {
      handlers.onPointerDown(touch(100));
      handlers.onPointerMove(touch(100 + distance));
      vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    });
    expect(openMenu).not.toHaveBeenCalled();
  });

  it("still opens the menu at the drag sensor's 6px boundary", async () => {
    await act(() => {
      handlers.onPointerDown(touch(100));
      handlers.onPointerMove(touch(106));
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(openMenu).toHaveBeenCalledExactlyOnceWith({ x: 100, y: 100 });
  });
});
