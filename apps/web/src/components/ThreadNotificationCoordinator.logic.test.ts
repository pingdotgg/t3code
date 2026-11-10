import { describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadNotificationGate,
  isSnoozedForNotification,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  requestId: null,
  settled: false,
  completedAt: null,
  snoozed: false,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  requestId: null,
  settled: true,
  completedAt: at,
  snoozed: false,
});
const visible = { archived: false, quiet: false, snoozed: false };

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
  it("does not notify completion while the thread is snoozed", () => {
    const { notify, observe } = harness();
    observe(working);
    observe({ ...completed(1), snoozed: true }, { ...visible, snoozed: true });
    expect(notify).not.toHaveBeenCalled();
    observe(completed(1));
    expect(notify).not.toHaveBeenCalled();
  });

  it("still notifies attention while the thread is snoozed", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(
      {
        attention: "run-1:approval:",
        requestId: null,
        settled: false,
        completedAt: null,
        snoozed: true,
      },
      { ...visible, snoozed: true },
    );
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
    const attention = {
      attention: "run-1:approval:a",
      requestId: "a",
      settled: false,
      completedAt: null,
      snoozed: false,
    };
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
    observe({
      attention: "run-1:limited",
      requestId: null,
      settled: false,
      completedAt: null,
      snoozed: false,
    });
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
});

describe("isSnoozedForNotification", () => {
  const wakeAt = Date.parse("2026-01-01T12:00:00.000Z");
  const snoozedThread = {
    snoozedAt: "2026-01-01T11:00:00.000Z",
    snoozedUntil: new Date(wakeAt).toISOString(),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  };

  it("is snoozed before the wake time", () => {
    expect(isSnoozedForNotification(snoozedThread, null, wakeAt - 1)).toBe(true);
  });

  it("keeps a completion from the snooze suppressed when processed after the wake", () => {
    expect(isSnoozedForNotification(snoozedThread, wakeAt - 1, wakeAt + 60_000)).toBe(true);
  });

  it("does not suppress a completion from before the snooze processed after the wake", () => {
    const snoozedAt = Date.parse(snoozedThread.snoozedAt);
    expect(isSnoozedForNotification(snoozedThread, snoozedAt - 1, wakeAt + 60_000)).toBe(false);
  });

  it("does not suppress a completion after the wake time", () => {
    expect(isSnoozedForNotification(snoozedThread, wakeAt + 1, wakeAt + 60_000)).toBe(false);
  });

  it("does not suppress after an early wake for attention", () => {
    const raised = { ...snoozedThread, hasPendingApprovals: true };
    expect(isSnoozedForNotification(raised, wakeAt - 1, wakeAt - 1)).toBe(false);
  });
});
