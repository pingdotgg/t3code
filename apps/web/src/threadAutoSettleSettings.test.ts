import { describe, expect, it } from "vite-plus/test";

import {
  clientThreadAutoSettlePatchForMode,
  resolveClientThreadAutoSettleMode,
  resolveClientThreadAutoSettlePolicy,
} from "./threadAutoSettleSettings";

describe("client thread auto-settle compatibility", () => {
  it.each([
    [null, "pull-request"],
    [3, "inactive-or-pull-request"],
  ] as const)("migrates legacy days=%s to %s", (days, expected) => {
    const settings = {
      sidebarAutoSettleAfterDays: days,
      sidebarAutoSettleMode: undefined,
    };
    expect(resolveClientThreadAutoSettleMode(settings)).toBe(expected);
    expect(resolveClientThreadAutoSettlePolicy(settings).mode).toBe(expected);
  });

  it.each(["never", "inactive", "pull-request", "inactive-or-pull-request"] as const)(
    "prefers the explicit %s mode",
    (mode) => {
      expect(
        resolveClientThreadAutoSettleMode({
          sidebarAutoSettleAfterDays: 7,
          sidebarAutoSettleMode: mode,
        }),
      ).toBe(mode);
    },
  );

  it("changes mode without discarding a custom inactivity threshold", () => {
    const pullRequestOnly = {
      sidebarAutoSettleAfterDays: 7,
      ...clientThreadAutoSettlePatchForMode({ mode: "pull-request", currentAfterDays: 7 }),
    };
    expect(pullRequestOnly).toEqual({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleMode: "pull-request",
    });
    expect(
      clientThreadAutoSettlePatchForMode({
        mode: "inactive",
        currentAfterDays: pullRequestOnly.sidebarAutoSettleAfterDays,
      }),
    ).toEqual({ sidebarAutoSettleMode: "inactive" });
  });

  it("restores the default threshold only when legacy settings have none", () => {
    expect(
      clientThreadAutoSettlePatchForMode({ mode: "inactive", currentAfterDays: null }),
    ).toEqual({
      sidebarAutoSettleAfterDays: 3,
      sidebarAutoSettleMode: "inactive",
    });
  });
});
