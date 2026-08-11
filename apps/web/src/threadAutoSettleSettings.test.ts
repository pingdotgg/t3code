import { describe, expect, it } from "vite-plus/test";

import {
  clientThreadAutoSettlePatchForMode,
  resolveClientThreadAutoSettleMode,
  resolveClientThreadAutoSettlePolicy,
} from "./threadAutoSettleSettings";

describe("client thread auto-settle compatibility", () => {
  it.each([
    [null, false, "never"],
    [3, false, "inactive"],
    [null, true, "pull-request"],
    [3, true, "inactive-or-pull-request"],
  ] as const)("resolves days=%s pull-request=%s to %s", (days, pullRequest, expected) => {
    const settings = {
      sidebarAutoSettleAfterDays: days,
      sidebarAutoSettleOnPullRequestCompletion: pullRequest,
    };
    expect(resolveClientThreadAutoSettleMode(settings)).toBe(expected);
    expect(resolveClientThreadAutoSettlePolicy(settings).mode).toBe(expected);
  });

  it("maps modes back to one atomic legacy-settings patch", () => {
    expect(clientThreadAutoSettlePatchForMode({ mode: "never", currentAfterDays: 7 })).toEqual({
      sidebarAutoSettleAfterDays: null,
      sidebarAutoSettleOnPullRequestCompletion: false,
    });
    expect(
      clientThreadAutoSettlePatchForMode({ mode: "inactive", currentAfterDays: null }),
    ).toEqual({
      sidebarAutoSettleAfterDays: 3,
      sidebarAutoSettleOnPullRequestCompletion: false,
    });
    expect(
      clientThreadAutoSettlePatchForMode({ mode: "pull-request", currentAfterDays: 7 }),
    ).toEqual({
      sidebarAutoSettleAfterDays: null,
      sidebarAutoSettleOnPullRequestCompletion: true,
    });
    expect(
      clientThreadAutoSettlePatchForMode({
        mode: "inactive-or-pull-request",
        currentAfterDays: null,
      }),
    ).toEqual({
      sidebarAutoSettleAfterDays: 3,
      sidebarAutoSettleOnPullRequestCompletion: true,
    });
  });
});
