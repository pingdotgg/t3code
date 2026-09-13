import { act, useLayoutEffect, type PointerEvent } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useResizableWidth } from "./useResizableWidth";

let renderer: ReactTestRenderer;
let result: ReturnType<typeof useResizableWidth>;
let captured = false;
const target = {
  setPointerCapture: () => {
    captured = true;
  },
  hasPointerCapture: () => captured,
  releasePointerCapture: () => {
    captured = false;
  },
};
const style = {
  cursor: "",
  userSelect: "",
  removeProperty(property: string) {
    if (property === "cursor") this.cursor = "";
    if (property === "user-select") this.userSelect = "";
  },
};
const setItem = vi.fn();
const cancelAnimationFrame = vi.fn();
let events: EventTarget;
let frame: FrameRequestCallback | undefined;

function pointer(clientX = 100) {
  return {
    button: 0,
    pointerId: 1,
    clientX,
    currentTarget: target,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as PointerEvent<HTMLElement>;
}

function Panel({ edge = "left", maxWidth = 800 }: { edge?: "left" | "right"; maxWidth?: number }) {
  const resize = useResizableWidth({
    storageKey: "test-panel-width",
    defaultWidth: 400,
    minWidth: 200,
    maxWidth,
    edge,
  });
  useLayoutEffect(() => {
    result = resize;
  });
  return null;
}

beforeEach(async () => {
  captured = false;
  frame = undefined;
  style.cursor = "";
  style.userSelect = "";
  events = new EventTarget();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    localStorage: { getItem: () => null, setItem },
  });
  vi.stubGlobal("document", { body: { style } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 42;
  });
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  await act(() => {
    renderer = create(<Panel />);
  });
});

afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("panel resize cleanup", () => {
  it.each(["unmount", "lost capture", "blur", "cancel"])(
    "clears the cursor and pending resize after %s",
    async (reason) => {
      await act(() => {
        result.handlers.onPointerDown(pointer());
        result.handlers.onPointerMove(pointer(50));
      });
      await act(() => frame?.(0));
      expect(result.width).toBe(450);
      // Queue another move to check that interruption cancels pending work too.
      await act(() => result.handlers.onPointerMove(pointer(25)));
      expect(style.cursor).toBe("col-resize");
      expect(style.userSelect).toBe("none");
      await act(() => {
        if (reason === "unmount") renderer.unmount();
        if (reason === "lost capture") result.handlers.onLostPointerCapture(pointer());
        if (reason === "blur") events.dispatchEvent(new Event("blur"));
        if (reason === "cancel") result.handlers.onPointerCancel(pointer());
      });
      expect(style.cursor).toBe("");
      expect(style.userSelect).toBe("");
      expect(captured).toBe(false);
      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
      if (reason === "unmount") {
        expect(setItem).not.toHaveBeenCalled();
      } else {
        expect(result.width).toBe(475);
        expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "475");
      }
    },
  );

  it.each(["left", "right"] as const)(
    "uses the release position for a fast %s-edge drag",
    async (edge) => {
      await act(() => renderer.update(<Panel edge={edge} />));
      await act(() => {
        result.handlers.onPointerDown(pointer());
        result.handlers.onPointerMove(pointer(edge === "left" ? 50 : 150));
        result.handlers.onPointerUp(pointer(edge === "left" ? 25 : 175));
      });
      expect(result.width).toBe(475);
      expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "475");
      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    },
  );

  it.each([
    [800, 450],
    [450, 800],
  ])("uses updated bounds during a drag from max %s to %s", async (initialMax, nextMax) => {
    await act(() => renderer.update(<Panel maxWidth={initialMax} />));
    await act(() => {
      result.handlers.onPointerDown(pointer());
      result.handlers.onPointerMove(pointer(-200));
    });
    await act(() => frame?.(0));
    expect(result.width).toBe(Math.min(700, initialMax));
    await act(() => renderer.update(<Panel maxWidth={nextMax} />));
    await act(() => result.handlers.onPointerMove(pointer(-250)));
    await act(() => frame?.(0));
    expect(result.width).toBe(Math.min(750, nextMax));
    await act(() => result.handlers.onPointerUp(pointer(-300)));
    expect(result.width).toBe(nextMax);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", String(nextMax));
  });

  it("handles release before any move event", async () => {
    await act(() => {
      result.handlers.onPointerDown(pointer());
      result.handlers.onPointerUp(pointer(25));
    });
    expect(result.width).toBe(475);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "475");
  });

  it("clamps the release position to the panel bounds", async () => {
    await act(() => {
      result.handlers.onPointerDown(pointer());
      result.handlers.onPointerUp(pointer(-1000));
    });
    expect(result.width).toBe(800);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "800");
  });

  it("saves the final width when release is followed by lost capture", async () => {
    await act(() => {
      result.handlers.onPointerDown(pointer());
      result.handlers.onPointerMove(pointer(50));
      result.handlers.onPointerUp(pointer(50));
      result.handlers.onLostPointerCapture(pointer(50));
    });
    expect(result.width).toBe(450);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "450");
    expect(style.cursor).toBe("");
    expect(captured).toBe(false);
  });
});
