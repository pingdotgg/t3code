import { describe, expect, it } from "@effect/vitest";

import {
  projectThreadContentPresentation,
  threadSyncStatusLabel,
} from "./threadContentPresentation";

describe("thread content presentation", () => {
  it("renders cached detail while its environment reconnects", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: true,
        detailError: null,
        detailDeleted: false,
        connectionState: "reconnecting",
      }),
    ).toEqual({ kind: "ready" });
  });

  it("explains uncached detail while disconnected instead of loading forever", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: false,
        detailError: null,
        detailDeleted: false,
        connectionState: "error",
      }),
    ).toEqual({
      kind: "unavailable",
      title: "Messages not cached",
      detail: "Reconnect this environment to load the conversation.",
    });
  });

  it("shows a sync failure over cached messages instead of syncing forever", () => {
    expect(threadSyncStatusLabel("cached", "ready", true)).toBe("Could not sync messages");
    expect(threadSyncStatusLabel("cached", "ready", false)).toBe("Syncing messages…");
  });
});
