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
