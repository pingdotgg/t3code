import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeScreenshotChordHandler, SCREENSHOT_CHORD_REFIRE_MS } from "./ScreenshotChord.ts";

function makeHarness(options?: { enabled?: boolean; isEnabled?: () => Promise<boolean> }) {
  const capture = vi.fn();
  const handler = makeScreenshotChordHandler({
    isEnabled: options?.isEnabled ?? (() => Promise.resolve(options?.enabled ?? true)),
    capture,
  });
  const send = async (left: boolean, right: boolean) => {
    handler({ left, right });
    // Let the isEnabled promise settle.
    await Promise.resolve();
    await Promise.resolve();
  };
  return { capture, send };
}

describe("makeScreenshotChordHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when both keys become held, in either order", async () => {
    const harness = makeHarness();
    await harness.send(true, false);
    expect(harness.capture).not.toHaveBeenCalled();
    await harness.send(true, true);
    expect(harness.capture).toHaveBeenCalledTimes(1);

    await harness.send(false, false);
    vi.advanceTimersByTime(SCREENSHOT_CHORD_REFIRE_MS + 100);
    await harness.send(false, true);
    await harness.send(true, true);
    expect(harness.capture).toHaveBeenCalledTimes(2);
  });

  it("never fires on a single command key", async () => {
    const harness = makeHarness();
    await harness.send(true, false);
    await harness.send(false, false);
    await harness.send(false, true);
    await harness.send(false, false);
    expect(harness.capture).not.toHaveBeenCalled();
  });

  it("fires once for duplicate both-down reports", async () => {
    // Another modifier toggling mid-chord re-reports the same ⌘ state.
    const harness = makeHarness();
    await harness.send(true, true);
    await harness.send(true, true);
    await harness.send(true, true);
    expect(harness.capture).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire on a one-sided release and re-press", async () => {
    const harness = makeHarness();
    await harness.send(true, true);
    vi.advanceTimersByTime(SCREENSHOT_CHORD_REFIRE_MS + 100);
    await harness.send(true, false);
    await harness.send(true, true);
    expect(harness.capture).toHaveBeenCalledTimes(1);
  });

  it("re-arms only after both keys are fully released", async () => {
    const harness = makeHarness();
    await harness.send(true, true);
    vi.advanceTimersByTime(SCREENSHOT_CHORD_REFIRE_MS + 100);
    await harness.send(false, true);
    await harness.send(false, false);
    await harness.send(true, false);
    await harness.send(true, true);
    expect(harness.capture).toHaveBeenCalledTimes(2);
  });

  it("debounces a re-chord inside the refire window", async () => {
    const harness = makeHarness();
    await harness.send(true, true);
    await harness.send(false, false);
    vi.advanceTimersByTime(SCREENSHOT_CHORD_REFIRE_MS - 100);
    await harness.send(true, true);
    expect(harness.capture).toHaveBeenCalledTimes(1);

    // The debounced chord is consumed, not deferred: it needs a fresh
    // release + re-chord after the window.
    await harness.send(false, false);
    vi.advanceTimersByTime(SCREENSHOT_CHORD_REFIRE_MS + 100);
    await harness.send(true, true);
    expect(harness.capture).toHaveBeenCalledTimes(2);
  });

  it("does not capture when disabled", async () => {
    const harness = makeHarness({ enabled: false });
    await harness.send(true, true);
    expect(harness.capture).not.toHaveBeenCalled();
  });

  it("does not capture when the settings read fails", async () => {
    const harness = makeHarness({ isEnabled: () => Promise.reject(new Error("nope")) });
    await harness.send(true, true);
    expect(harness.capture).not.toHaveBeenCalled();
  });

  it("discards a stale isEnabled resolution from a superseded chord", async () => {
    const resolvers: Array<(enabled: boolean) => void> = [];
    const harness = makeHarness({
      isEnabled: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    await harness.send(true, true);
    await harness.send(false, false);
    vi.advanceTimersByTime(SCREENSHOT_CHORD_REFIRE_MS + 100);
    await harness.send(true, true);
    expect(resolvers).toHaveLength(2);

    // Chord #1 resolves late — only chord #2's resolution may capture.
    resolvers[0]?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.capture).not.toHaveBeenCalled();
    resolvers[1]?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.capture).toHaveBeenCalledTimes(1);
  });

  it("still captures when the keys are released before isEnabled resolves", async () => {
    // The user's intent completed at chord time; a slow settings read must
    // not swallow the capture.
    const resolvers: Array<(enabled: boolean) => void> = [];
    const harness = makeHarness({
      isEnabled: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    await harness.send(true, true);
    await harness.send(false, false);
    resolvers[0]?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.capture).toHaveBeenCalledTimes(1);
  });
});
