import { describe, expect, it } from "@effect/vitest";

import { refreshStateForWindowChange, type UsageRefreshState } from "./usageRefreshState.ts";

describe("refreshStateForWindowChange", () => {
  it("preserves a boundary refresh through commit and its success or failure", () => {
    const refreshing: UsageRefreshState = {
      windowKey: "window-b",
      requestId: 1,
      refreshing: true,
      error: null,
    };

    expect(refreshStateForWindowChange(refreshing, "window-b", "window-b")).toBe(refreshing);

    const success = { ...refreshing, refreshing: false };
    expect(refreshStateForWindowChange(success, "window-b", "window-b")).toBe(success);

    const failure = { ...refreshing, refreshing: false, error: "refresh failed" };
    expect(refreshStateForWindowChange(failure, "window-b", "window-b")).toBe(failure);
  });

  it("resets an old-window request and advances its id", () => {
    const old: UsageRefreshState = {
      windowKey: "window-a",
      requestId: 4,
      refreshing: true,
      error: null,
    };

    expect(refreshStateForWindowChange(old, "window-b", "window-a")).toEqual({
      windowKey: "window-b",
      requestId: 5,
      refreshing: false,
      error: null,
    });
  });
});
