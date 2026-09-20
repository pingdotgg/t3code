import { describe, expect, it } from "vite-plus/test";

import { resolveSourceControlPanelPresentationState } from "./sourceControlPanel";

describe("resolveSourceControlPanelPresentationState", () => {
  it("keeps first-load state distinct from an unavailable panel", () => {
    expect(
      resolveSourceControlPanelPresentationState({
        snapshot: null,
        loading: true,
        error: null,
        statusPending: false,
        statusError: null,
      }),
    ).toEqual({
      status: "loading",
      message: "Loading repository state...",
    });
  });

  it("keeps an interrupted initial load pending without hiding either error source", () => {
    const pending = {
      snapshot: null,
      loading: false,
      error: null,
      statusPending: true,
      statusError: null,
    };
    expect(resolveSourceControlPanelPresentationState(pending)).toEqual({
      status: "loading",
      message: "Loading repository state...",
    });
    expect(
      resolveSourceControlPanelPresentationState({
        ...pending,
        error: "Snapshot failed",
      }),
    ).toEqual({
      status: "unavailable",
      message: "Snapshot failed",
      canCopyError: true,
    });
    expect(
      resolveSourceControlPanelPresentationState({
        ...pending,
        statusError: new Error("offline"),
      }),
    ).toEqual({
      status: "unavailable",
      message: "Source control status is unavailable.",
      canCopyError: false,
    });
  });

  it("keeps showing cached panel data while a refresh is in flight", () => {
    expect(
      resolveSourceControlPanelPresentationState({
        snapshot: {} as never,
        loading: true,
        error: null,
        statusPending: false,
        statusError: null,
      }),
    ).toEqual({
      status: "ready",
      syncMessage: "Refreshing repository state...",
    });
  });

  it("does not show a refresh message only because the live status subscription is pending", () => {
    expect(
      resolveSourceControlPanelPresentationState({
        snapshot: {} as never,
        loading: false,
        error: null,
        statusPending: true,
        statusError: null,
      }),
    ).toEqual({
      status: "ready",
      syncMessage: null,
    });
  });

  it("reports live status sync failures without discarding cached panel data", () => {
    expect(
      resolveSourceControlPanelPresentationState({
        snapshot: {} as never,
        loading: false,
        error: null,
        statusPending: false,
        statusError: new Error("offline"),
      }),
    ).toEqual({
      status: "ready",
      syncMessage: "Live status sync failed. Showing last loaded repository state.",
    });
  });
});
