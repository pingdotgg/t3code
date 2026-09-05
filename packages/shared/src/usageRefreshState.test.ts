import { describe, expect, it } from "@effect/vitest";

import {
  completeUsageRefresh,
  refreshStateForWindowChange,
  startUsageRefresh,
  type UsageRefreshState,
} from "./usageRefreshState.ts";

describe("refreshStateForWindowChange", () => {
  it("starts a refresh with the next request id", () => {
    expect(startUsageRefresh(4, "window-b")).toEqual({
      windowKey: "window-b",
      requestId: 5,
      refreshing: true,
      error: null,
    });
  });

  it.each([
    [null, null],
    ["refresh failed", "refresh failed"],
  ] as const)("settles an active request with %s", (error, expectedError) => {
    expect(completeUsageRefresh("window-b", 5, "window-b", 5, error)).toEqual({
      windowKey: "window-b",
      requestId: 5,
      refreshing: false,
      error: expectedError,
    });
  });

  it("ignores a completion for an obsolete request", () => {
    expect(completeUsageRefresh("window-c", 6, "window-b", 5, null)).toBeNull();
  });

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
