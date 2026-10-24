import { describe, expect, it } from "@effect/vitest";

import { projectThreadContentPresentation } from "./threadContentPresentation";

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

  it("keeps a pending creation's prompt visible before its thread exists", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: false,
        detailError: null,
        detailDeleted: true,
        connectionState: "connected",
        hasPendingCreation: true,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("surfaces a synchronization failure while creation is still pending", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: false,
        detailError: "Message synchronization timed out.",
        detailDeleted: false,
        connectionState: "connected",
        hasPendingCreation: true,
      }),
    ).toEqual({
      kind: "unavailable",
      title: "Could not load conversation",
      detail: "Message synchronization timed out.",
    });
  });

  it("keeps cached messages visible after a synchronization failure during creation", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: true,
        detailError: "Message synchronization timed out.",
        detailDeleted: false,
        connectionState: "connected",
        hasPendingCreation: true,
      }),
    ).toEqual({ kind: "ready" });
  });
});
