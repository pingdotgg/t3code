import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { WindowZoomIndicator } from "./WindowZoomIndicator";

it("reports actual window zoom, ignores ordinary resizing, and clears after reset", async () => {
  const original = window.desktopBridge;
  let zoom = 1;
  window.desktopBridge = {
    getWindowZoomFactor: () => zoom,
  } as NonNullable<typeof window.desktopBridge>;
  using _timers = fakeTimers();
  try {
    await using screen = await render(<WindowZoomIndicator />);
    expect(screen.container.textContent).toBe("");
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.container.textContent).toBe("");
    zoom = 1.5;
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.container.textContent).toBe("150%");
    await act(() => vi.advanceTimersByTime(1500));
    zoom = 1;
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.container.textContent).toBe("100%");
    await act(() => vi.advanceTimersByTime(1999));
    expect(screen.container.textContent).toBe("100%");
    await act(() => vi.advanceTimersByTime(1));
    expect(screen.container.textContent).toBe("");
  } finally {
    if (original) window.desktopBridge = original;
    else delete window.desktopBridge;
  }
});
