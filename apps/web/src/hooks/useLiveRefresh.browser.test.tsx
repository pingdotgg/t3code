import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { LIVE_REFRESH_IDLE_AFTER_MS, useLiveRefresh } from "./useLiveRefresh";

function setup() {
  using stack = new DisposableStack();
  stack.use(fakeTimers());
  let visibility: DocumentVisibilityState = "visible";
  stack.use(vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility));
  const environment = stack.move();
  return {
    refresh: vi.fn(),
    setVisibility(next: DocumentVisibilityState) {
      visibility = next;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    [Symbol.dispose]: () => environment.dispose(),
  };
}

describe("live refresh cadence", () => {
  it("polls every 45 seconds, pauses while hidden or busy, respects disabling, and cleans up", async () => {
    using env = setup();
    const { refresh } = env;
    vi.setSystemTime(0);
    function Probe({ pending = false, enabled = true }) {
      useLiveRefresh(pending ? null : refresh, { intervalMs: 45_000, enabled });
      return null;
    }
    await using screen = await render(<Probe />);
    await act(() => vi.advanceTimersByTime(44_999));
    expect(refresh).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    env.setVisibility("hidden");
    await act(() => vi.advanceTimersByTime(90_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    env.setVisibility("visible");
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(3);
    await screen.rerender(<Probe pending />);
    await act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(3);
    await screen.rerender(<Probe />);
    await act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(4);
    await screen.rerender(<Probe enabled={false} />);
    await act(() => vi.advanceTimersByTime(90_000));
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(4);
    await screen.rerender(null);
    await act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it.each(["focus", "visibilitychange"])(
    "keeps an idle view paused after %s until input",
    async (event) => {
      using env = setup();
      const { refresh } = env;
      vi.setSystemTime(1_000_000);
      function Probe() {
        useLiveRefresh(refresh, { intervalMs: 45_000 });
        return null;
      }
      await using _screen = await render(<Probe />);
      await act(() => vi.advanceTimersByTime(LIVE_REFRESH_IDLE_AFTER_MS));
      refresh.mockClear();
      await act(() => (event === "focus" ? window : document).dispatchEvent(new Event(event)));
      expect(refresh).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(90_000));
      expect(refresh).not.toHaveBeenCalled();
      await act(() => document.dispatchEvent(new Event("pointerdown")));
      expect(refresh).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTime(45_000));
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );
});
