import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "./useResizableWidth";

const STORAGE_KEY = "test:responsive-panel-width";

function Panel({ defaultWidth }: { defaultWidth: number }) {
  const { width, setWidth, handlers } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth,
    minWidth: 160,
    maxWidth: 560,
    edge: "left",
  });
  return (
    <>
      <button onClick={() => setWidth(350)}>{width}</button>
      <div role="separator" style={{ width: 8, height: 40 }} {...handlers} />
    </>
  );
}

function ScrollerBesideHandle() {
  const { handlers } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth: 240,
    minWidth: 160,
    maxWidth: 560,
    edge: "left",
  });
  return (
    <div style={{ position: "relative", width: 200, height: 100 }}>
      <div data-testid="scroller" style={{ height: 100, overflowY: "scroll" }}>
        <div style={{ height: 8400 }} />
      </div>
      {/* The coarse-pointer handle starts left of the 6px scrollbar gutter. */}
      <div
        role="separator"
        style={{ position: "absolute", top: 0, bottom: 0, right: -8, width: 16 }}
        {...handlers}
      />
    </div>
  );
}

describe("useResizableWidth", () => {
  it("drags the scrollbar thumb it overlaps and resizes elsewhere", async () => {
    // This hook only needs React and layout; no navigation is involved.
    await using screen = await render(<ScrollerBesideHandle />, { router: false });
    const handle = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const scroller = screen.container.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    // Test Chromium hides scrollbars, so reserve the 6px gutter the app's styled scrollbar takes.
    Object.defineProperty(scroller, "clientWidth", { value: scroller.offsetWidth - 6 });
    using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
    const { top, right } = scroller.getBoundingClientRect();
    const mouse = { bubbles: true, pointerType: "mouse", pointerId: 1, button: 0 };
    // Just past the scroller's edge, where only the handle can take the pointer.
    const onThumb = { ...mouse, clientX: right + 1, clientY: top + 4 };
    const besideThumb = { ...onThumb, clientX: right + 3 };
    const belowThumb = { ...onThumb, clientY: top + 60 };

    // Content alone makes a 1px thumb, but Chromium draws at least 17px; its ends grab slightly past.
    for (const thumbEnd of [onThumb, { ...onThumb, clientY: top + 20 }]) {
      await act(() => handle.dispatchEvent(new PointerEvent("pointermove", thumbEnd)));
      expect(handle.dataset.hoverZone).toBe("scrollbar-thumb");
      expect(scroller.hasAttribute("data-scrollbar-thumb-hover")).toBe(true);
    }
    for (const elsewhere of [{ ...besideThumb, pointerType: "pen" }, belowThumb]) {
      await act(() => handle.dispatchEvent(new PointerEvent("pointermove", elsewhere)));
      expect(handle.dataset.hoverZone).toBe("resize");
      expect(scroller.hasAttribute("data-scrollbar-thumb-hover")).toBe(false);
    }

    // A 17px thumb on a 100px track over 8300px of scroll range moves 100px of content per pixel.
    const scrollerPresses: EventTarget[] = [];
    scroller.addEventListener("pointerdown", (event) => scrollerPresses.push(event.target!));
    await act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", onThumb));
      handle.dispatchEvent(new PointerEvent("pointermove", { ...onThumb, clientY: top + 28 }));
      handle.dispatchEvent(new PointerEvent("pointerup", { ...onThumb, clientY: top + 28 }));
    });
    expect(scroller.scrollTop).toBe(2400);
    expect(handle.parentElement!.style.getPropertyValue(RESIZABLE_WIDTH_PROPERTY)).toBe("");
    // The chat timeline reads a press on its scroll node as the user taking over the scroll.
    expect(scrollerPresses).toEqual([scroller]);

    // Releasing outside the window can skip pointerup; leaving the window ends the drag instead.
    const onMovedThumb = { ...onThumb, clientY: top + 28 };
    await act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", onMovedThumb));
      window.dispatchEvent(new Event("blur"));
      handle.dispatchEvent(new PointerEvent("pointermove", { ...onMovedThumb, clientY: top + 38 }));
    });
    expect(scroller.scrollTop).toBe(2400);

    await act(() => handle.dispatchEvent(new PointerEvent("pointerdown", belowThumb)));
    expect(document.body.style.cursor).toBe("col-resize");
    await act(() => handle.dispatchEvent(new PointerEvent("pointerup", belowThumb)));
  });

  it("follows a responsive default until the user saves a width", async () => {
    const previous = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    try {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<Panel defaultWidth={320} />, { router: false });
      expect(screen.container.textContent).toBe("320");
      await screen.rerender(<Panel defaultWidth={200} />);
      expect(screen.container.textContent).toBe("200");

      await act(() => screen.container.querySelector("button")!.click());
      await screen.rerender(<Panel defaultWidth={180} />);
      expect(screen.container.textContent).toBe("350");

      await screen.unmount();
      await using restored = await render(<Panel defaultWidth={200} />, { router: false });
      expect(restored.container.textContent).toBe("350");
    } finally {
      if (previous === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previous);
    }
  });

  it("keeps the default responsive after a stationary click and persists an actual drag", async () => {
    const previous = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    try {
      // This hook only needs browser storage and React; no navigation is involved.
      await using screen = await render(<Panel defaultWidth={240} />, { router: false });
      await screen.getByRole("separator").click();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      await screen.rerender(<Panel defaultWidth={256} />);
      expect(screen.container.textContent).toBe("256");

      const handle = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
      // Synthetic drag events have no active browser pointer to capture.
      using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
      const pointer = { bubbles: true, pointerId: 1, button: 0 };
      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 500 }));
      });
      await screen.rerender(<Panel defaultWidth={280} />);
      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 500 }));
      });
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(screen.container.style.getPropertyValue(RESIZABLE_WIDTH_PROPERTY)).toBe("280px");

      await act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 500 }));
        handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 450 }));
      });
      expect(localStorage.getItem(STORAGE_KEY)).toBe("330");
      await screen.rerender(<Panel defaultWidth={200} />);
      expect(screen.container.textContent).toBe("330");
    } finally {
      if (previous === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previous);
    }
  });
});
