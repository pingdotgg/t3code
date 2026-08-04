import { describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement } from "react";

const hooks = vi.hoisted(() => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T): T => callback,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useCallback: hooks.useCallback };
});

import { HueStrip } from "./ProjectColorPicker";

function pointerEvent(clientX: number, pointerId = 1) {
  const currentTarget = {
    getBoundingClientRect: () => ({ left: 0, width: 100 }),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
  };

  return {
    currentTarget,
    clientX,
    pointerId,
  } as unknown as React.PointerEvent<HTMLDivElement>;
}

describe("HueStrip pointer interaction", () => {
  it("previews during a drag and commits only when the pointer is released", () => {
    const preview = vi.fn();
    const commit = vi.fn();
    const strip = HueStrip({ hue: 180, onChange: preview, onCommit: commit });
    const slider = strip.props.children[0] as ReactElement<{
      onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
      onPointerMove?: (event: React.PointerEvent<HTMLDivElement>) => void;
      onPointerUp?: (event: React.PointerEvent<HTMLDivElement>) => void;
    }>;

    slider.props.onPointerDown?.(pointerEvent(10));
    slider.props.onPointerMove?.(pointerEvent(20));
    slider.props.onPointerMove?.(pointerEvent(30));

    expect(preview).toHaveBeenCalledTimes(3);
    expect(commit).not.toHaveBeenCalled();

    slider.props.onPointerUp?.(pointerEvent(30));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(108);
  });
});
