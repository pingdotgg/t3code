import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  makeQuitShortcutHandler,
  QUIT_DOUBLE_PRESS_MS,
  QUIT_HOLD_DURATION_MS,
  QUIT_HOLD_RELEASE_GRACE_MS,
} from "./QuitHold.ts";
import type { QuitHoldKeyInput } from "./QuitHold.ts";
import type { QuitConfirmationMode, QuitShortcutHintEvent } from "@t3tools/contracts";

const HOLD_DOWN = { state: "down", mode: "hold" } as const;
const DOUBLE_CLICK_DOWN = { state: "down", mode: "double-click" } as const;
const UP = { state: "up" } as const;

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
  mode?: QuitConfirmationMode;
  platform?: NodeJS.Platform;
  getMode?: () => Promise<QuitConfirmationMode>;
}) {
  const notifications: Array<QuitShortcutHintEvent> = [];
  const quit = vi.fn();
  const handler = makeQuitShortcutHandler({
    platform: options?.platform ?? "darwin",
    getMode: options?.getMode ?? (() => Promise.resolve(options?.mode ?? "hold")),
    notify: (event) => notifications.push(event),
    quit,
  });
  const preventDefault = vi.fn();
  const send = async (input: QuitHoldKeyInput) => {
    handler({ preventDefault }, input);
    // Let the getMode promise settle.
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

describe("makeQuitShortcutHandler", () => {
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
    expect(harness.notifications).toEqual([HOLD_DOWN]);

    vi.advanceTimersByTime(QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS);
    expect(harness.quit).not.toHaveBeenCalled();
    // The watchdog dismisses the hint once the press is clearly over.
    expect(harness.notifications).toEqual([HOLD_DOWN, UP]);
  });

  it("quits after a completed hold is released", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200);
    expect(harness.quit).not.toHaveBeenCalled();
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    expect(harness.quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(QUIT_HOLD_RELEASE_GRACE_MS);
    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual([HOLD_DOWN, UP]);
  });

  it("waits for Q release when Cmd is released first", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200);
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    harness.preventDefault.mockClear();
    await harness.send(makeInput({ meta: false, isAutoRepeat: true }));
    expect(harness.preventDefault).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(QUIT_HOLD_RELEASE_GRACE_MS * 2);
    expect(harness.quit).not.toHaveBeenCalled();
    await harness.send(makeInput({ type: "keyUp", meta: false }));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("does not quit when the hold stops before the duration", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(500);
    await harness.send(makeInput({ type: "keyUp" }));
    expect(harness.notifications).toEqual([HOLD_DOWN, UP]);
    vi.advanceTimersByTime((QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS) * 2);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("cancels the hold when the modifier is released first", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    expect(harness.notifications).toEqual([HOLD_DOWN, UP]);
    vi.advanceTimersByTime((QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS) * 2);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("quits without showing a hint in direct mode", async () => {
    const harness = makeHarness({ mode: "direct" });
    await harness.send(makeInput({}));
    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual([]);
  });

  it("honors direct mode when the key is released before its mode read settles", async () => {
    let resolveMode: ((mode: QuitConfirmationMode) => void) | undefined;
    const harness = makeHarness({
      getMode: () =>
        new Promise((resolve) => {
          resolveMode = resolve;
        }),
    });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));

    resolveMode?.("direct");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual([]);
  });

  it("does not arm hold mode after a released key's mode read settles", async () => {
    let resolveMode: ((mode: QuitConfirmationMode) => void) | undefined;
    const harness = makeHarness({
      getMode: () =>
        new Promise((resolve) => {
          resolveMode = resolve;
        }),
    });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));

    resolveMode?.("hold");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([]);
  });

  it("honors a quick double press when both key releases beat their mode reads", async () => {
    const resolvers: Array<(mode: QuitConfirmationMode) => void> = [];
    const harness = makeHarness({
      getMode: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS - 100);
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));

    resolvers[1]?.("double-click");
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual([]);
  });

  it("discards a stale mode resolution from a superseded press", async () => {
    // Press #1's mode is still pending when the user releases and
    // presses again; its late resolution must not act for press #2.
    const resolvers: Array<(mode: QuitConfirmationMode) => void> = [];
    const harness = makeHarness({
      getMode: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    // Outside the double-press window, so the second press starts a new hold.
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS + 100);
    await harness.send(makeInput({}));
    expect(resolvers).toHaveLength(2);

    // Press #1 resolves late with "direct". It must not quit press #2.
    resolvers[0]?.("direct");
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.quit).not.toHaveBeenCalled();

    // Press #2 resolves to hold and completes the gesture.
    resolvers[1]?.("hold");
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200);
    await harness.send(makeInput({ type: "keyUp" }));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("quits on a quick double press in double-click mode when the first release is unseen", async () => {
    const harness = makeHarness({ mode: "double-click" });
    await harness.send(makeInput({}));
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS - 100);
    await harness.send(makeInput({}));
    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN, UP]);
  });

  it("keeps the double-press hint visible after key release until the window ends", async () => {
    const harness = makeHarness({ mode: "double-click" });
    await harness.send(makeInput({}));
    vi.advanceTimersByTime(100);
    await harness.send(makeInput({ type: "keyUp" }));
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN]);

    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS - 101);
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN]);
    vi.advanceTimersByTime(1);
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN, UP]);
  });

  it("accepts a second full shortcut after the modifier is released and pressed again", async () => {
    const harness = makeHarness({ mode: "double-click" });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    vi.advanceTimersByTime(100);

    await harness.send(makeInput({ key: "Meta" }));
    await harness.send(makeInput({}));

    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN, UP]);
  });

  it("expires a delayed double-press hint from keydown rather than mode resolution", async () => {
    let resolveMode: ((mode: QuitConfirmationMode) => void) | undefined;
    const harness = makeHarness({
      getMode: () =>
        new Promise((resolve) => {
          resolveMode = resolve;
        }),
    });
    await harness.send(makeInput({}));
    vi.advanceTimersByTime(100);
    await harness.send(makeInput({ type: "keyUp" }));
    vi.advanceTimersByTime(100);
    resolveMode?.("double-click");
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN]);

    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS - 201);
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN]);
    vi.advanceTimersByTime(1);
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN, UP]);
  });

  it("treats two slow presses as separate attempts in double-click mode", async () => {
    const harness = makeHarness({ mode: "double-click" });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS + 100);
    await harness.send(makeInput({}));
    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN, UP, DOUBLE_CLICK_DOWN]);
  });

  it("does not treat two quick presses as a quit in hold mode", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    vi.advanceTimersByTime(QUIT_DOUBLE_PRESS_MS - 100);
    await harness.send(makeInput({}));
    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([HOLD_DOWN, UP, HOLD_DOWN]);
  });

  it("cancels the hold when another key interrupts it", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(500);
    // Shift pressed mid-hold breaks the gesture...
    await harness.send(makeInput({ shift: true }));
    expect(harness.notifications).toEqual([HOLD_DOWN, UP]);
    // ...so later repeats past the threshold must not quit.
    await harness.holdFor(QUIT_HOLD_DURATION_MS);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("does not count an interrupted press toward a double press", async () => {
    const harness = makeHarness({ mode: "double-click" });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ shift: true }));
    // A fresh press right after the interruption starts a new attempt.
    await harness.send(makeInput({}));
    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([DOUBLE_CLICK_DOWN, UP, DOUBLE_CLICK_DOWN]);
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
    await harness.send(makeInput({ type: "keyUp", meta: false, control: true }));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });
});
