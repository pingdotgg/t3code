import { useRef, useState } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useSidebarSwipe } from "./sidebarSwipe";

function Harness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const sheetRef = useRef<HTMLDivElement>(null);
  useSidebarSwipe({ enabled: true, open, setOpen, sheetRef });
  return <div ref={sheetRef} data-open={open} onTouchMove={(event) => event.stopPropagation()} />;
}

function touch(target: HTMLElement, type: string, x: number, y: number, ended = false) {
  const point = new Touch({ identifier: 0, target, clientX: x, clientY: y });
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: ended ? [] : [point],
    changedTouches: [point],
  });
  target.dispatchEvent(event);
  return event;
}

function pointer(target: HTMLElement, type: string, x: number, pointerType = "touch") {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 7,
      pointerType,
      isPrimary: true,
      clientX: x,
      clientY: 200,
    }),
  );
}

describe("sidebar touch events", () => {
  it("opens when touch and pointer IDs differ, even after pointer cancellation", async () => {
    await using screen = await render(<Harness />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      pointer(target, "pointerdown", 8);
      touch(target, "touchstart", 8, 200);
      pointer(target, "pointermove", 28);
      expect(touch(target, "touchmove", 28, 201).defaultPrevented).toBe(true);
      pointer(target, "pointercancel", 28);
      touch(target, "touchmove", 90, 201);
      touch(target, "touchend", 90, 201, true);
    });
    expect(target.dataset.open).toBe("true");
  });

  it("opens from the middle of the page", async () => {
    await using screen = await render(<Harness />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      touch(target, "touchstart", 200, 200);
      expect(touch(target, "touchmove", 280, 201).defaultPrevented).toBe(true);
      touch(target, "touchend", 280, 201, true);
    });
    expect(target.dataset.open).toBe("true");
  });

  it("preserves horizontal scrolling inside code blocks", async () => {
    await using screen = await render(<Harness />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    const code = document.createElement("pre");
    code.style.cssText = "width: 100px; overflow-x: auto";
    const content = document.createElement("code");
    content.style.cssText = "display: block; width: 500px";
    content.textContent = "A wide code block";
    code.append(content);
    target.append(code);
    expect(getComputedStyle(code).overflowX).toBe("auto");
    expect(code.scrollWidth).toBeGreaterThan(code.clientWidth + 1);
    await act(() => {
      touch(content, "touchstart", 200, 200);
      expect(touch(content, "touchmove", 280, 201).defaultPrevented).toBe(false);
      touch(content, "touchend", 280, 201, true);
    });
    expect(target.dataset.open).toBe("false");
  });

  it("closes when the sheet stops touch events from bubbling", async () => {
    await using screen = await render(<Harness initiallyOpen />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      pointer(target, "pointerdown", 250);
      touch(target, "touchstart", 250, 200);
      expect(touch(target, "touchmove", 170, 201).defaultPrevented).toBe(true);
      touch(target, "touchend", 170, 201, true);
    });
    expect(target.dataset.open).toBe("false");
  });

  it("leaves vertical scrolling alone", async () => {
    await using screen = await render(<Harness initiallyOpen />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      touch(target, "touchstart", 250, 200);
      expect(touch(target, "touchmove", 248, 270).defaultPrevented).toBe(false);
      touch(target, "touchend", 170, 280, true);
    });
    expect(target.dataset.open).toBe("true");
  });

  it("keeps mouse drags inert and supports pen drags", async () => {
    await using screen = await render(<Harness />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      pointer(target, "pointerdown", 8, "mouse");
      pointer(target, "pointerup", 90, "mouse");
    });
    expect(target.dataset.open).toBe("false");
    await act(() => {
      pointer(target, "pointerdown", 8, "pen");
      pointer(target, "pointermove", 90, "pen");
      pointer(target, "pointerup", 90, "pen");
    });
    expect(target.dataset.open).toBe("true");
  });
});
