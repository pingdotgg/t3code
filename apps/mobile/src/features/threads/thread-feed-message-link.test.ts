import { describe, expect, it } from "vite-plus/test";

import { resolveLinkedMessageStep } from "./thread-feed-message-link";

const absent = {
  presented: false,
  inFeed: false,
  foldedRunId: null,
  synced: true,
  historyLoading: false,
  historyError: null,
  hasMoreHistory: true,
  lastLoadChangedNothing: false,
};

describe("resolveLinkedMessageStep", () => {
  it("scrolls to a message the feed shows, even before the thread syncs", () => {
    expect(resolveLinkedMessageStep({ ...absent, presented: true, synced: false })).toBe("scroll");
  });

  it("expands the turn that hides the message", () => {
    expect(resolveLinkedMessageStep({ ...absent, inFeed: true, foldedRunId: "run-1" })).toBe(
      "expand",
    );
  });

  it("does not page history for a loaded message that no fold hides", () => {
    expect(resolveLinkedMessageStep({ ...absent, inFeed: true })).toBe("missing");
  });

  it("waits for the sync and any history load before deciding the message is older", () => {
    expect(resolveLinkedMessageStep({ ...absent, synced: false })).toBe("wait");
    expect(resolveLinkedMessageStep({ ...absent, historyLoading: true })).toBe("wait");
    expect(resolveLinkedMessageStep({ ...absent, presented: true, historyLoading: true })).toBe(
      "wait",
    );
  });

  it("loads earlier history until it runs out, then reports the message missing", () => {
    expect(resolveLinkedMessageStep(absent)).toBe("load");
    expect(resolveLinkedMessageStep({ ...absent, hasMoreHistory: false })).toBe("missing");
  });

  it("reports a failed load instead of a missing message", () => {
    expect(resolveLinkedMessageStep({ ...absent, historyError: "offline" })).toBe("failed");
    expect(resolveLinkedMessageStep({ ...absent, lastLoadChangedNothing: true })).toBe("failed");
  });
});
