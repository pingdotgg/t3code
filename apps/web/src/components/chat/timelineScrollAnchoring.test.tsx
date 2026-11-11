import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { observeTimelineRun, resolveDisclosureRevealScrollDelta } from "./timelineScrollAnchoring";

describe("observeTimelineRun", () => {
  const existing = {
    threadKey: "environment:thread",
    hydrated: true,
    runId: RunId.make("existing-run"),
    queued: false,
    messageId: MessageId.make("existing-message"),
  };
  const next = {
    ...existing,
    runId: RunId.make("new-run"),
    messageId: MessageId.make("new-message"),
  };

  it("does not mistake delayed hydration for a newly started turn", () => {
    const loading = { ...existing, hydrated: false, runId: null, messageId: null };
    const opened = observeTimelineRun(null, loading);
    const stillLoading = observeTimelineRun(opened.observation, loading);
    const hydrated = observeTimelineRun(stillLoading.observation, existing);
    expect(hydrated.anchorMessageId).toBeNull();
    expect(observeTimelineRun(hydrated.observation, next).anchorMessageId).toBe(next.messageId);
  });

  it("keeps the end position while a stale cached run is replaced during synchronization", () => {
    const cached = observeTimelineRun(null, { ...existing, hydrated: false });
    const synchronizing = observeTimelineRun(cached.observation, { ...next, hydrated: false });
    expect(synchronizing.anchorMessageId).toBeNull();
    const live = observeTimelineRun(synchronizing.observation, next);
    expect(live.anchorMessageId).toBeNull();
    expect(
      observeTimelineRun(live.observation, {
        ...next,
        runId: RunId.make("later-run"),
        messageId: MessageId.make("later-message"),
      }).anchorMessageId,
    ).toBe("later-message");
  });

  it("waits for a new run's user message and frames it only once", () => {
    const opened = observeTimelineRun(null, existing);
    const waiting = observeTimelineRun(opened.observation, { ...next, messageId: null });
    expect(waiting.anchorMessageId).toBeNull();
    const ready = observeTimelineRun(waiting.observation, next);
    expect(ready.anchorMessageId).toBe(next.messageId);
    expect(observeTimelineRun(ready.observation, next).anchorMessageId).toBeNull();
  });

  it("does not reset the baseline during a temporary loss of projection data", () => {
    const opened = observeTimelineRun(null, existing);
    const reconnecting = observeTimelineRun(opened.observation, {
      ...existing,
      hydrated: false,
      runId: null,
    });
    expect(observeTimelineRun(reconnecting.observation, existing).anchorMessageId).toBeNull();
  });

  it("waits for a queued run to start before framing it", () => {
    const opened = observeTimelineRun(null, { ...existing, queued: true });
    expect(opened.anchorMessageId).toBeNull();
    expect(observeTimelineRun(opened.observation, existing).anchorMessageId).toBe(
      existing.messageId,
    );
  });
});

describe("resolveDisclosureRevealScrollDelta", () => {
  const viewport = {
    viewportTop: 0,
    viewportBottom: 800,
    composerOverlayHeight: 150,
    anchorOffset: 24,
  };

  it("does not scroll when the expanded row ends above the composer", () => {
    expect(resolveDisclosureRevealScrollDelta({ ...viewport, rowTop: 300, rowBottom: 650 })).toBe(
      0,
    );
  });

  it("scrolls content hidden behind the composer into view", () => {
    expect(resolveDisclosureRevealScrollDelta({ ...viewport, rowTop: 560, rowBottom: 900 })).toBe(
      250,
    );
  });

  it("keeps the header of a row taller than the usable viewport visible", () => {
    expect(resolveDisclosureRevealScrollDelta({ ...viewport, rowTop: 600, rowBottom: 2000 })).toBe(
      576,
    );
  });

  it("never scrolls backwards when the row header is already above the anchor inset", () => {
    expect(resolveDisclosureRevealScrollDelta({ ...viewport, rowTop: -40, rowBottom: 1200 })).toBe(
      0,
    );
  });
});
