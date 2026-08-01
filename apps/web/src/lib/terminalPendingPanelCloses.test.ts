import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearPendingPanelCloses,
  pendingPanelCloseVersion,
  recordPendingPanelClose,
  resolvePendingPanelCloses,
  subscribePendingPanelCloses,
} from "./terminalPendingPanelCloses";

const snapshot = {
  surfaceId: "terminal:terminal-1" as const,
  resourceId: "terminal-1",
  terminalIds: ["terminal-1", "terminal-2"],
  splitDirection: "vertical" as const,
};

// Recorded at t=1000; the settle grace makes entries eligible at t=2500.
const RECORDED_AT = 1_000;
const BEFORE_GRACE = 2_000;
const AFTER_GRACE = 3_000;

beforeEach(() => {
  clearPendingPanelCloses("thread-a");
});

describe("terminalPendingPanelCloses", () => {
  it("restores a snapshot when post-grace metadata shows the session survived", () => {
    recordPendingPanelClose("thread-a", "terminal-2", snapshot, RECORDED_AT);

    expect(
      resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"], AFTER_GRACE),
    ).toEqual([{ terminalId: "terminal-2", snapshot }]);
    // Settled: a later metadata update must not restore it a second time.
    expect(
      resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"], AFTER_GRACE),
    ).toEqual([]);
  });

  it("does not settle against metadata cached from before the close attempt", () => {
    // The cached list still contains the id because the close's metadata has
    // not propagated yet; restoring from it would pin a dead pane.
    recordPendingPanelClose("thread-a", "terminal-2", snapshot, RECORDED_AT);

    expect(
      resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"], BEFORE_GRACE),
    ).toEqual([]);
    // Still pending: post-grace metadata settles it.
    expect(
      resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"], AFTER_GRACE),
    ).toEqual([{ terminalId: "terminal-2", snapshot }]);
  });

  it("discards a snapshot when metadata shows the session really closed", () => {
    recordPendingPanelClose("thread-a", "terminal-2", snapshot, RECORDED_AT);

    expect(resolvePendingPanelCloses("thread-a", ["terminal-1"], AFTER_GRACE)).toEqual([]);
    expect(
      resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"], AFTER_GRACE),
    ).toEqual([]);
  });

  it("waits for loaded metadata instead of resolving against an empty list", () => {
    recordPendingPanelClose("thread-a", "terminal-2", snapshot, RECORDED_AT);

    // An empty list is indistinguishable from metadata that has not arrived.
    expect(resolvePendingPanelCloses("thread-a", [], AFTER_GRACE)).toEqual([]);
    expect(
      resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"], AFTER_GRACE),
    ).toEqual([{ terminalId: "terminal-2", snapshot }]);
  });

  it("settles a close as real against an authoritative empty list", () => {
    // The closed terminal was the last session: loaded [] must settle the
    // entry as closed, or the snapshot survives until the id is reused and
    // resurrects a stale surface.
    recordPendingPanelClose("thread-a", "terminal-2", snapshot, RECORDED_AT);

    expect(resolvePendingPanelCloses("thread-a", [], AFTER_GRACE, true)).toEqual([]);
    expect(resolvePendingPanelCloses("thread-a", ["terminal-2"], AFTER_GRACE, true)).toEqual([]);
  });

  it("restores surviving snapshots in reverse close order", () => {
    // Nested closes of panes 2 then 3: LIFO restore reproduces [1,2,3];
    // insertion order would land on [1,3,2].
    recordPendingPanelClose("thread-a", "terminal-2", snapshot, RECORDED_AT);
    recordPendingPanelClose(
      "thread-a",
      "terminal-3",
      { ...snapshot, terminalIds: ["terminal-1", "terminal-3"] },
      RECORDED_AT,
    );

    const restored = resolvePendingPanelCloses(
      "thread-a",
      ["terminal-1", "terminal-2", "terminal-3"],
      AFTER_GRACE,
      true,
    );
    expect(restored.map((entry) => entry.terminalId)).toEqual(["terminal-3", "terminal-2"]);
  });

  it("notifies subscribers when a recorded close becomes eligible", () => {
    vi.useFakeTimers();
    try {
      let notified = 0;
      const unsubscribe = subscribePendingPanelCloses(() => {
        notified += 1;
      });
      const versionBefore = pendingPanelCloseVersion();

      recordPendingPanelClose("thread-a", "terminal-2", snapshot, RECORDED_AT);

      // The notification is deferred by the grace timer, not synchronous.
      expect(notified).toBe(0);
      vi.advanceTimersByTime(1_500);
      expect(notified).toBe(1);
      expect(pendingPanelCloseVersion()).toBeGreaterThan(versionBefore);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes pending closes per thread", () => {
    recordPendingPanelClose("thread-a", "terminal-2", snapshot, RECORDED_AT);
    recordPendingPanelClose("thread-b", "terminal-2", snapshot, RECORDED_AT);

    expect(resolvePendingPanelCloses("thread-a", ["terminal-2"], AFTER_GRACE)).toHaveLength(1);
    expect(resolvePendingPanelCloses("thread-b", ["terminal-2"], AFTER_GRACE)).toHaveLength(1);
    clearPendingPanelCloses("thread-b");
  });
});
