import { describe, expect, it } from "vite-plus/test";

import { resolveMobileThreadAutoSettlePolicy } from "./thread-auto-settle.logic";

describe("mobile thread auto-settle policy", () => {
  it("defaults to the combined three-day policy", () => {
    expect(resolveMobileThreadAutoSettlePolicy({})).toEqual({
      mode: "inactive-or-pull-request",
      afterDays: 3,
    });
  });

  it.each([
    ["never", { mode: "never" }],
    ["inactive", { mode: "inactive", afterDays: 3 }],
    ["pull-request", { mode: "pull-request" }],
    ["inactive-or-pull-request", { mode: "inactive-or-pull-request", afterDays: 3 }],
  ] as const)("resolves the %s preference", (mode, expected) => {
    expect(resolveMobileThreadAutoSettlePolicy({ threadAutoSettleMode: mode })).toEqual(expected);
  });
});
