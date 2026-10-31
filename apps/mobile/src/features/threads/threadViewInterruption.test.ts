import { describe, expect, it } from "vite-plus/test";

import { nextThreadViewState } from "./threadViewInterruption";

describe("nextThreadViewState", () => {
  it("counts a thread opened while synced and in the foreground at once", () => {
    expect(nextThreadViewState(null, "env:a", true)).toEqual({ key: "env:a", interrupted: false });
  });

  it("waits for a thread opened while syncing or in the background", () => {
    expect(nextThreadViewState(null, "env:a", false)).toEqual({ key: "env:a", interrupted: true });
  });

  it("keeps waiting after a resume or sync interrupts the view, until another thread opens", () => {
    const opened = nextThreadViewState(null, "env:a", true);
    const hidden = nextThreadViewState(opened, "env:a", false);
    expect(hidden).toEqual({ key: "env:a", interrupted: true });
    expect(nextThreadViewState(hidden, "env:a", true)).toBe(hidden);
    expect(nextThreadViewState(hidden, "env:b", true)).toEqual({
      key: "env:b",
      interrupted: false,
    });
  });

  it("returns the same state while nothing changes", () => {
    const opened = nextThreadViewState(null, "env:a", true);
    expect(nextThreadViewState(opened, "env:a", true)).toBe(opened);
    expect(nextThreadViewState(opened, null, true)).toBeNull();
  });
});
