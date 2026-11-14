import { describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadNotificationGate,
  isSnoozedForNotification,
  RELEASED_COMPLETION_GRACE_MS,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  requestId: null,
  settled: false,
  completedAt: null,
  backgroundWake: false,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  requestId: null,
  settled: true,
  completedAt: at,
  backgroundWake: false,
});
const waking: ThreadNotificationObservation = { ...working, backgroundWake: true };
const woke = (at: number): ThreadNotificationObservation => ({
  ...completed(at),
  backgroundWake: true,
});
const visible = { archived: false, quiet: false, snoozed: false };
const snoozed = { ...visible, snoozed: true };

function fakeTimers(): Disposable {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

function harness() {
  const notify = vi.fn();
  const gate = createThreadNotificationGate<string>(notify);
  let prior: ThreadNotificationObservation | undefined;
  const observe = (next: ThreadNotificationObservation, options = visible) => {
    gate.observe("thread", prior, next, options);
    prior = next;
  };
  return { gate, notify, observe };
}

describe("createThreadNotificationGate", () => {
  it("skips a completion seen while snoozed, but still notifies attention", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1), snoozed);
    observe({ ...completed(1) });
    expect(notify).not.toHaveBeenCalled();
    observe({ ...working, attention: "run-2:approval" }, snoozed);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("notifies a completion immediately and only once", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    observe(working);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies each newer completion immediately", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe(working);
    observe(completed(2));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "completion"],
    ]);
    observe(completed(1));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("notifies each attention once per stretch and still notifies the subsequent completion", () => {
    const { notify, observe } = harness();
    observe(working);
    const attention = { ...working, attention: "run-1:approval:a", requestId: "a" };
    observe(attention);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    observe({ ...attention });
    expect(notify).toHaveBeenCalledTimes(1);
    observe({ ...attention, attention: "run-1:approval:b", requestId: "b" });
    observe(attention);
    expect(notify).toHaveBeenCalledTimes(2);
    observe(working);
    observe(attention);
    expect(notify).toHaveBeenCalledTimes(3);
    const subagent = { ...attention, attention: "run-1:approval:", requestId: null };
    observe(subagent);
    observe(attention);
    observe(subagent);
    expect(notify).toHaveBeenCalledTimes(5);
    observe(working);
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("does not replay a completion after attention resolves", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    observe({ ...working, attention: "run-1:limited" });
    observe(completed(1));
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("never notifies existing, archived or stopped completions, including when unarchived", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    observe(completed(2));
    observe(working);
    observe(completed(3), { ...visible, archived: true });
    observe(completed(3));
    expect(notify).not.toHaveBeenCalled();
    observe(working);
    observe(completed(4));
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("forgets handled completions when a thread is removed or the gate is cleared", () => {
    for (const reset of [
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.retain(new Set()),
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.clear(),
    ]) {
      const { gate, notify, observe } = harness();
      observe(completed(1));
      reset(gate);
      gate.observe("thread", undefined, working, visible);
      gate.observe("thread", working, completed(1), visible);
      expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    }
  });

  it("waits out the grace before notifying a wake's completion, and a final wake replaces it", () => {
    using _timers = fakeTimers();
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    // Held until the monitor left, or completing after it already had: either way unheld here.
    observe(waking);
    observe(woke(2));
    expect(notify).toHaveBeenCalledTimes(1);
    observe(working);
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(notify).toHaveBeenCalledTimes(1);
    observe(completed(3));
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "completion"],
    ]);
  });

  it("notifies a wake's completion once after the grace when no run follows, even across a pause", () => {
    using _timers = fakeTimers();
    const { gate, notify, observe } = harness();
    observe(waking);
    observe(woke(1));
    gate.pause();
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(notify).not.toHaveBeenCalled();
    observe({ ...woke(1) });
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS - 1);
    observe({ ...woke(1) });
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...woke(1) });
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drops a pending wake completion when the thread is snoozed", () => {
    using _timers = fakeTimers();
    const { notify, observe } = harness();
    observe(waking);
    observe(woke(1));
    observe({ ...woke(1) }, snoozed);
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    expect(notify).not.toHaveBeenCalled();
  });

  it("drops a pending wake completion when the thread is removed or the gate is cleared", () => {
    using _timers = fakeTimers();
    for (const reset of [
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.retain(new Set()),
      (gate: ReturnType<typeof createThreadNotificationGate<string>>) => gate.clear(),
    ]) {
      const { gate, notify, observe } = harness();
      observe(waking);
      observe(woke(1));
      reset(gate);
      vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
      expect(notify).not.toHaveBeenCalled();
    }
  });
});

describe("isSnoozedForNotification", () => {
  const snoozedAt = Date.parse("2026-01-01T11:00:00.000Z");
  const wakeAt = Date.parse("2026-01-01T12:00:00.000Z");
  const thread = {
    snoozedAt: new Date(snoozedAt).toISOString(),
    snoozedUntil: new Date(wakeAt).toISOString(),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };
  const later = wakeAt + 60_000;

  it.each([
    ["during the snooze, processed after the wake", thread, wakeAt - 1, later, true],
    ["before the snooze, processed after the wake", thread, snoozedAt - 1, later, false],
    ["after the wake", thread, wakeAt + 1, later, false],
    [
      "after an early wake for attention",
      { ...thread, hasPendingApprovals: true },
      wakeAt - 1,
      wakeAt - 1,
      false,
    ],
  ])("a completion %s is suppressed: %s", (_name, shell, completedAt, now, expected) => {
    expect(isSnoozedForNotification(shell, completedAt, now)).toBe(expected);
  });
});
