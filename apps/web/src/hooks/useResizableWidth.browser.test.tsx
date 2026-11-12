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

function dragLeftBy(handle: Element, distance: number) {
  const init = { bubbles: true, button: 0, pointerId: 1 };
  handle.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: 500 }));
  handle.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: 500 - distance }));
  handle.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: 500 - distance }));
}

describe("useResizableWidth", () => {
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

  it("follows a width another tab stores under the same key", async () => {
    using _storage = { [Symbol.dispose]: () => localStorage.removeItem(STORAGE_KEY) };
    // This hook only needs browser storage and React; no navigation is involved.
    await using screen = await render(<Panel defaultWidth={400} />, { router: false });
    await expect.element(screen.getByText("400")).toBeInTheDocument();

    // Another tab's write reaches this one only as a storage event.
    await act(() => {
      localStorage.setItem(STORAGE_KEY, "500");
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });
    await expect.element(screen.getByText("500")).toBeInTheDocument();
  });

  it("keeps a width storage rejected for the next drag and a new default", async () => {
    using _storage = { [Symbol.dispose]: () => localStorage.removeItem(STORAGE_KEY) };
    // This hook only needs browser storage and React; no navigation is involved.
    await using screen = await render(<Panel defaultWidth={400} />, { router: false });
    // Synthetic pointer ids are not active pointers, so the browser would reject capture.
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});
    using _write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full.", "QuotaExceededError");
    });
    using _log = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = screen.getByRole("separator").element();

    await act(() => dragLeftBy(handle, 100));
    await expect.element(screen.getByText("500")).toBeInTheDocument();

    await act(() => dragLeftBy(handle, 50));
    await expect.element(screen.getByText("550")).toBeInTheDocument();

    await screen.rerender(<Panel defaultWidth={200} />);
    await expect.element(screen.getByText("550")).toBeInTheDocument();
  });
});
