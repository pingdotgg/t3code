import { beforeEach, describe, expect, it } from "vite-plus/test";

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

beforeEach(() => {
  clearPendingPanelCloses("thread-a");
});

describe("terminalPendingPanelCloses", () => {
  it("restores a snapshot when metadata shows the session survived the interrupted close", () => {
    recordPendingPanelClose("thread-a", "terminal-2", snapshot);

    expect(resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"])).toEqual([
      { terminalId: "terminal-2", snapshot },
    ]);
    // Settled: a later metadata update must not restore it a second time.
    expect(resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"])).toEqual([]);
  });

  it("discards a snapshot when metadata shows the session really closed", () => {
    recordPendingPanelClose("thread-a", "terminal-2", snapshot);

    expect(resolvePendingPanelCloses("thread-a", ["terminal-1"])).toEqual([]);
    expect(resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"])).toEqual([]);
  });

  it("waits for loaded metadata instead of resolving against an empty list", () => {
    recordPendingPanelClose("thread-a", "terminal-2", snapshot);

    // An empty list is indistinguishable from metadata that has not arrived.
    expect(resolvePendingPanelCloses("thread-a", [])).toEqual([]);
    expect(resolvePendingPanelCloses("thread-a", ["terminal-1", "terminal-2"])).toEqual([
      { terminalId: "terminal-2", snapshot },
    ]);
  });

  it("notifies subscribers when a close is recorded", () => {
    // The settling effect must re-run even when session metadata never changes
    // again (the session survived, or metadata arrived before the record).
    let notified = 0;
    const unsubscribe = subscribePendingPanelCloses(() => {
      notified += 1;
    });
    const versionBefore = pendingPanelCloseVersion();

    recordPendingPanelClose("thread-a", "terminal-2", snapshot);

    expect(notified).toBe(1);
    expect(pendingPanelCloseVersion()).toBeGreaterThan(versionBefore);
    unsubscribe();
    recordPendingPanelClose("thread-a", "terminal-3", snapshot);
    expect(notified).toBe(1);
  });

  it("scopes pending closes per thread", () => {
    recordPendingPanelClose("thread-a", "terminal-2", snapshot);
    recordPendingPanelClose("thread-b", "terminal-2", snapshot);

    expect(resolvePendingPanelCloses("thread-a", ["terminal-2"])).toHaveLength(1);
    expect(resolvePendingPanelCloses("thread-b", ["terminal-2"])).toHaveLength(1);
    clearPendingPanelCloses("thread-b");
  });
});
