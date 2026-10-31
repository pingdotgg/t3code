import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadNotificationGate,
  isSnoozedForNotification,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  settled: false,
  completedAt: null,
  snoozed: false,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not notify completion while the thread is snoozed", () => {
    const { notify, observe } = harness();
    observe(working);
    observe({ ...completed(1), snoozed: true }, { ...visible, snoozed: true });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("still notifies attention while the thread is snoozed", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(
      { attention: "run-1:approval", settled: false, completedAt: null, snoozed: true },
      { ...visible, snoozed: true },
    );
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("drops a completion when the thread resumes within the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    observe(working);
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies a real completion once after the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies attention at once and replaces a pending completion", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-1:approval", settled: false, completedAt: null, snoozed: false });
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    vi.advanceTimersByTime(60_000);
    // The request resolves and the same run reads as completed again.
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("notifies one completion across continuation gaps", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(2));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(3));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("keeps a completion interrupted by attention after a working gap from firing", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe({ attention: "run-1:approval", settled: false, completedAt: null, snoozed: false });
    vi.advanceTimersByTime(60_000);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("adds nothing when attention follows a completion that already fired", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    observe({ attention: "run-1:limited", settled: false, completedAt: null, snoozed: false });
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("still notifies a newer completion after attention", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-2:approval", settled: false, completedAt: null, snoozed: false });
    observe(working);
    observe(completed(2));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("ignores unrelated updates while a completion waits", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies a run that settles again after a brief runtime blip", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("drops a pending completion when the thread is snoozed during a runtime blip", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ ...working, snoozed: true }, { ...visible, snoozed: true });
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("drops a cancelled completion when the thread is snoozed later in the same blip", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe({ ...working, snoozed: true }, { ...visible, snoozed: true });
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("restarts the grace when a newer completion replaces a pending one", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe(completed(2));
    vi.advanceTimersByTime(1_500);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drops a pending completion on archive, stop request, removal or clear", () => {
    for (const end of [
      (h: ReturnType<typeof harness>) => h.observe(completed(1), { ...visible, archived: true }),
      (h: ReturnType<typeof harness>) =>
        h.observe({ ...completed(1) }, { ...visible, quiet: true }),
      (h: ReturnType<typeof harness>) => h.gate.retain(new Set()),
      (h: ReturnType<typeof harness>) => h.gate.clear(),
    ]) {
      const h = harness();
      h.observe(working);
      h.observe(completed(1));
      end(h);
      vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
      expect(h.notify).not.toHaveBeenCalled();
    }
  });

  it("never notifies a stopped run or the first observation", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
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
