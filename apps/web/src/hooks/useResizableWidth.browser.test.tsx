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
        <div style={{ height: 1000 }} />
      </div>
      <div
        role="separator"
        style={{ position: "absolute", top: 0, bottom: 0, right: -4, width: 8 }}
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

    // The thumb spans 0-10px; its ends keep grabbing it slightly past its drawn edge.
    for (const thumbEnd of [onThumb, { ...onThumb, clientY: top + 12 }]) {
      await act(() => handle.dispatchEvent(new PointerEvent("pointermove", thumbEnd)));
      expect(handle.style.cursor).toBe("default");
      expect(handle.dataset.scrollbarThumb).toBe("");
      expect(scroller.hasAttribute("data-scrollbar-thumb-hover")).toBe(true);
    }
    for (const elsewhere of [besideThumb, belowThumb]) {
      await act(() => handle.dispatchEvent(new PointerEvent("pointermove", elsewhere)));
      expect(handle.style.cursor).toBe("");
      expect(handle.dataset.scrollbarThumb).toBeUndefined();
      expect(scroller.hasAttribute("data-scrollbar-thumb-hover")).toBe(false);
    }

    // A 10px thumb on a 100px track over 900px of scroll range moves 10px of content per pixel.
    await act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", onThumb));
      handle.dispatchEvent(new PointerEvent("pointermove", { ...onThumb, clientY: top + 24 }));
      handle.dispatchEvent(new PointerEvent("pointerup", { ...onThumb, clientY: top + 24 }));
    });
    expect(scroller.scrollTop).toBe(200);
    expect(handle.parentElement!.style.getPropertyValue(RESIZABLE_WIDTH_PROPERTY)).toBe("");

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
