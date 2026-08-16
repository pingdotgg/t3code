import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  makeQuitHoldHandler,
  QUIT_DOUBLE_TAP_MS,
  QUIT_HOLD_DURATION_MS,
  QUIT_HOLD_RELEASE_GRACE_MS,
} from "./QuitHold.ts";
import type { QuitHoldKeyInput, QuitHoldState } from "./QuitHold.ts";

function makeInput(overrides: Partial<QuitHoldKeyInput>): QuitHoldKeyInput {
  return {
    type: "keyDown",
    key: "q",
    meta: true,
    control: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    ...overrides,
  };
}

function makeHarness(options?: {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  isEnabled?: () => Promise<boolean>;
}) {
  const notifications: Array<QuitHoldState> = [];
  const quit = vi.fn();
  const handler = makeQuitHoldHandler({
    platform: options?.platform ?? "darwin",
    isEnabled: options?.isEnabled ?? (() => Promise.resolve(options?.enabled ?? true)),
    notify: (state) => notifications.push(state),
    quit,
  });
  const preventDefault = vi.fn();
  const send = async (input: QuitHoldKeyInput) => {
    handler({ preventDefault }, input);
    // Let the isEnabled promise settle.
    await Promise.resolve();
    await Promise.resolve();
  };
  // Simulates the OS auto-repeating the held shortcut every `intervalMs`.
  const holdFor = async (
    durationMs: number,
    repeatOverrides: Partial<QuitHoldKeyInput> = {},
    intervalMs = 100,
  ) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += intervalMs) {
      vi.advanceTimersByTime(intervalMs);
      await send(makeInput({ isAutoRepeat: true, ...repeatOverrides }));
    }
  };
  return { notifications, quit, preventDefault, send, holdFor };
}

describe("makeQuitHoldHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the hint on a tap without quitting, even when the release is never seen", async () => {
    // macOS suppresses the letter's keyUp while Cmd is held, so a tap may
    // produce no keyUp at all. Quit must still not fire.
    const harness = makeHarness();
    await harness.send(makeInput({}));
    expect(harness.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual(["down"]);

    vi.advanceTimersByTime(QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS);
    expect(harness.quit).not.toHaveBeenCalled();
    // The watchdog dismisses the hint once the press is clearly over.
    expect(harness.notifications).toEqual(["down", "up"]);
  });

  it("quits once the shortcut auto-repeats past the hold duration", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(QUIT_HOLD_DURATION_MS - 200);
    expect(harness.quit).not.toHaveBeenCalled();
    await harness.holdFor(400);
    expect(harness.quit).toHaveBeenCalledTimes(1);
    // Exactly one hint cycle for the whole hold.
    expect(harness.notifications).toEqual(["down", "up"]);
  });

  it("does not quit when the hold stops before the duration", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(500);
    await harness.send(makeInput({ type: "keyUp" }));
    expect(harness.notifications).toEqual(["down", "up"]);
    vi.advanceTimersByTime((QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS) * 2);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("cancels the hold when the modifier is released first", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    expect(harness.notifications).toEqual(["down", "up"]);
    vi.advanceTimersByTime((QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS) * 2);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("quits immediately on a single press when disabled", async () => {
    const harness = makeHarness({ enabled: false });
    await harness.send(makeInput({}));
    expect(harness.quit).toHaveBeenCalledTimes(1);
    // The hint is dismissed in case the quit gets cancelled downstream.
    expect(harness.notifications).toEqual(["down", "up"]);
  });

  it("discards a stale isEnabled resolution from a superseded press", async () => {
    // Press #1's isEnabled is still pending when the user releases and
    // presses again; its late resolution must not act for press #2.
    const resolvers: Array<(enabled: boolean) => void> = [];
    const harness = makeHarness({
      isEnabled: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    // Outside the double-tap window, so the second press starts a new hold.
    vi.advanceTimersByTime(QUIT_DOUBLE_TAP_MS + 100);
    await harness.send(makeInput({}));
    expect(resolvers).toHaveLength(2);

    // Press #1 resolves late with "disabled" — it must not quit press #2.
    resolvers[0]?.(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.quit).not.toHaveBeenCalled();

    // Press #2 resolves enabled and completes a full hold.
    resolvers[1]?.(true);
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200);
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("quits on a quick double tap, even when the first release was never seen", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    vi.advanceTimersByTime(QUIT_DOUBLE_TAP_MS - 100);
    await harness.send(makeInput({}));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("treats two slow taps as separate presses", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    vi.advanceTimersByTime(QUIT_DOUBLE_TAP_MS + 100);
    await harness.send(makeInput({}));
    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual(["down", "up", "down"]);
  });

  it("cancels the hold when another key interrupts it", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(500);
    // Shift pressed mid-hold breaks the gesture...
    await harness.send(makeInput({ shift: true }));
    expect(harness.notifications).toEqual(["down", "up"]);
    // ...so later repeats past the threshold must not quit.
    await harness.holdFor(QUIT_HOLD_DURATION_MS);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("does not count an interrupted press toward a double tap", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ shift: true }));
    // A fresh press right after the interruption starts a new hold, not a
    // double-tap quit.
    await harness.send(makeInput({}));
    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual(["down", "up", "down"]);
  });

  it("ignores other shortcuts", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({ key: "w" }));
    await harness.send(makeInput({ shift: true }));
    await harness.send(makeInput({ meta: false }));
    expect(harness.preventDefault).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([]);
  });

  it("uses control on non-mac platforms", async () => {
    const harness = makeHarness({ platform: "linux" });
    await harness.send(makeInput({ meta: false, control: true }));
    expect(harness.preventDefault).toHaveBeenCalledTimes(1);
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200, { meta: false, control: true });
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });
});
