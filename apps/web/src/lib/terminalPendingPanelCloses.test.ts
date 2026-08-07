import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearPendingPanelClose,
  clearPendingPanelCloses,
  pendingPanelCloseVersion,
  recordPendingPanelClose,
  resolvePendingPanelCloses,
  subscribePendingPanelCloses,
} from "./terminalPendingPanelCloses";

const snapshot = {
  surfaceId: "terminal:term-1" as const,
  resourceId: "term-1",
  surfaceIndex: 0,
  terminalIds: ["term-1", "term-2", "term-3"],
  splitDirection: "vertical" as const,
};

beforeEach(() => {
  clearPendingPanelCloses("thread-a");
  clearPendingPanelCloses("thread-b");
});

describe("terminalPendingPanelCloses", () => {
  it("restores a surviving close only after the settle grace", () => {
    recordPendingPanelClose("thread-a", "term-2", snapshot, 1_000);

    expect(resolvePendingPanelCloses("thread-a", ["term-1", "term-2"], 2_000)).toEqual([]);
    expect(resolvePendingPanelCloses("thread-a", ["term-1", "term-2"], 3_000)).toEqual([
      { terminalId: "term-2", snapshot },
    ]);
    expect(resolvePendingPanelCloses("thread-a", ["term-1", "term-2"], 3_000)).toEqual([]);
  });

  it("drops a snapshot when the server confirms the close", () => {
    recordPendingPanelClose("thread-a", "term-2", snapshot, 1_000);

    expect(resolvePendingPanelCloses("thread-a", ["term-1"], 3_000)).toEqual([]);
    expect(resolvePendingPanelCloses("thread-a", ["term-1", "term-2"], 3_000)).toEqual([]);
  });

  it("does not treat an unloaded empty list as authoritative", () => {
    recordPendingPanelClose("thread-a", "term-2", snapshot, 1_000);

    expect(resolvePendingPanelCloses("thread-a", [], 3_000)).toEqual([]);
    expect(resolvePendingPanelCloses("thread-a", ["term-1", "term-2"], 3_000)).toEqual([
      { terminalId: "term-2", snapshot },
    ]);
  });

  it("treats an authoritative empty list as a confirmed close", () => {
    recordPendingPanelClose("thread-a", "term-2", snapshot, 1_000);

    expect(resolvePendingPanelCloses("thread-a", [], 3_000, true)).toEqual([]);
    expect(resolvePendingPanelCloses("thread-a", ["term-2"], 3_000, true)).toEqual([]);
  });

  it("restores nested closes in reverse order and allows id reuse to cancel a stale snapshot", () => {
    recordPendingPanelClose("thread-a", "term-2", snapshot, 1_000);
    recordPendingPanelClose(
      "thread-a",
      "term-3",
      { ...snapshot, terminalIds: ["term-1", "term-3"] },
      1_000,
    );

    expect(
      resolvePendingPanelCloses("thread-a", ["term-1", "term-2", "term-3"], 3_000, true).map(
        (entry) => entry.terminalId,
      ),
    ).toEqual(["term-3", "term-2"]);

    recordPendingPanelClose("thread-a", "term-2", snapshot, 1_000);
    clearPendingPanelClose("thread-a", "term-2");
    expect(resolvePendingPanelCloses("thread-a", ["term-2"], 3_000, true)).toEqual([]);
  });

  it("notifies subscribers when a close becomes eligible", () => {
    vi.useFakeTimers();
    try {
      let notifications = 0;
      const unsubscribe = subscribePendingPanelCloses(() => {
        notifications += 1;
      });
      const versionBefore = pendingPanelCloseVersion();

      recordPendingPanelClose("thread-a", "term-2", snapshot);
      expect(notifications).toBe(0);
      vi.advanceTimersByTime(1_500);
      expect(notifications).toBe(1);
      expect(pendingPanelCloseVersion()).toBeGreaterThan(versionBefore);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules the earliest interrupted close when closes overlap", () => {
    vi.useFakeTimers();
    try {
      let notifications = 0;
      const unsubscribe = subscribePendingPanelCloses(() => {
        notifications += 1;
      });

      vi.setSystemTime(1_000);
      recordPendingPanelClose("thread-a", "term-2", snapshot);
      vi.advanceTimersByTime(1_000);
      recordPendingPanelClose("thread-a", "term-3", snapshot);

      vi.advanceTimersByTime(499);
      expect(notifications).toBe(0);
      vi.advanceTimersByTime(1);
      expect(notifications).toBe(1);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
