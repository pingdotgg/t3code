import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LIVE_REFRESH_IDLE_AFTER_MS, useLiveRefresh } from "./useLiveRefresh";

let root: Root;
let visibility: DocumentVisibilityState;
const refresh = vi.fn();

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  refresh.mockReset();
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live refresh cadence", () => {
  it("polls every 45 seconds, pauses while hidden or busy, respects disabling, and cleans up", () => {
    vi.setSystemTime(0);
    function Probe({ pending = false, enabled = true }) {
      useLiveRefresh(pending ? null : refresh, { intervalMs: 45_000, enabled });
      return null;
    }
    act(() => root.render(<Probe />));
    act(() => vi.advanceTimersByTime(44_999));
    expect(refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    setVisibility("hidden");
    act(() => vi.advanceTimersByTime(90_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    setVisibility("visible");
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(3);
    act(() => root.render(<Probe pending />));
    act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(3);
    act(() => root.render(<Probe />));
    act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(4);
    act(() => root.render(<Probe enabled={false} />));
    act(() => vi.advanceTimersByTime(90_000));
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(4);
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(45_000));
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it.each(["focus", "visibilitychange"])(
    "keeps an idle view paused after %s until input",
    (event) => {
      vi.setSystemTime(1_000_000);
      function Probe() {
        useLiveRefresh(refresh, { intervalMs: 45_000 });
        return null;
      }
      act(() => root.render(<Probe />));
      act(() => vi.advanceTimersByTime(LIVE_REFRESH_IDLE_AFTER_MS));
      refresh.mockClear();
      act(() => (event === "focus" ? window : document).dispatchEvent(new Event(event)));
      expect(refresh).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(90_000));
      expect(refresh).not.toHaveBeenCalled();
      act(() => document.dispatchEvent(new Event("pointerdown")));
      expect(refresh).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(45_000));
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );
});
