import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useResizableWidth } from "./useResizableWidth";

const STORAGE_KEY = "t3code:test:resizable-width";

function Probe() {
  const { width, handlers } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth: 400,
    minWidth: 300,
    maxWidth: 800,
    edge: "left",
  });
  return (
    <div>
      <output>{width}</output>
      <div role="separator" {...handlers} />
    </div>
  );
}

function dragLeftBy(handle: Element, distance: number) {
  const init = { bubbles: true, button: 0, pointerId: 1 };
  handle.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: 500 }));
  handle.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: 500 - distance }));
  handle.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: 500 - distance }));
}

describe("useResizableWidth", () => {
  it("follows a width another tab stores under the same key", async () => {
    using _storage = { [Symbol.dispose]: () => localStorage.removeItem(STORAGE_KEY) };
    await using screen = await render(<Probe />, {
      // A bare hook probe; nothing here navigates.
      router: false,
    });
    await expect.element(screen.getByText("400")).toBeInTheDocument();

    // Another tab's write reaches this one only as a storage event.
    await act(() => {
      localStorage.setItem(STORAGE_KEY, "640");
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });
    await expect.element(screen.getByText("640")).toBeInTheDocument();
  });

  it("starts the next drag from a width storage rejected", async () => {
    using _storage = { [Symbol.dispose]: () => localStorage.removeItem(STORAGE_KEY) };
    await using screen = await render(<Probe />, {
      // A bare hook probe; nothing here navigates.
      router: false,
    });
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
  });
});
