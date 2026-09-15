import { act, useLayoutEffect, type PointerEvent } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useResizeDrag } from "./useResizeDrag";

let renderer: ReactTestRenderer;
let handlers: ReturnType<typeof useResizeDrag<HTMLDivElement>>;
let frame: FrameRequestCallback | undefined;
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

function pointer(clientX: number, clientY: number) {
  return {
    button: 0,
    pointerId: 1,
    clientX,
    clientY,
    currentTarget: target,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as PointerEvent<HTMLDivElement>;
}

function ResizeHarness({
  resize,
  finish,
}: {
  resize: (value: number) => number;
  finish: () => void;
}) {
  const nextHandlers = useResizeDrag<HTMLDivElement>(() => ({
    width: 200,
    axis: "y",
    edge: "right",
    resize,
    finish,
  }));
  useLayoutEffect(() => {
    handlers = nextHandlers;
  });
  return null;
}

beforeEach(() => {
  captured = false;
  frame = undefined;
  style.cursor = "";
  style.userSelect = "";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("document", { body: { style } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 42;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("vertical resize drag", () => {
  it("uses clientY and the row resize cursor", async () => {
    const resize = vi.fn((value: number) => value);
    const finish = vi.fn();
    await act(() => {
      renderer = create(<ResizeHarness resize={resize} finish={finish} />);
    });

    await act(() => {
      handlers.onPointerDown(pointer(100, 300));
      handlers.onPointerMove(pointer(500, 325));
    });
    expect(style.cursor).toBe("row-resize");
    await act(() => frame?.(0));
    expect(resize).toHaveBeenLastCalledWith(225);

    await act(() => handlers.onPointerUp(pointer(900, 340)));
    expect(resize).toHaveBeenLastCalledWith(240);
    expect(finish).toHaveBeenCalledWith(240, true);
  });
});
