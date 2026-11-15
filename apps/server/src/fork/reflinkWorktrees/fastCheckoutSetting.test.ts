import { describe, expect, it } from "@effect/vitest";

import {
  checkoutCacheRetention,
  fastCheckoutCapabilities,
  fastCheckoutFor,
  sameCheckoutCacheRetention,
} from "./fastCheckoutSetting.ts";

const settings = {
  fastWorktreeCheckout: false,
  reflinkWorktrees: true,
  worktreesDirectory: "/w",
};

describe("fast checkout setting", () => {
  it.each([
    ["darwin", false, { fastWorktreeCheckout: true }],
    ["linux", true, { reflinkWorktrees: true }],
    ["win32", false, {}],
    ["freebsd", false, {}],
  ] as const)("%s honors its own setting", (platform, enabled, capabilities) => {
    expect(fastCheckoutFor(settings, platform)).toBe(enabled);
    expect(fastCheckoutCapabilities(platform)).toEqual(capabilities);
    expect(checkoutCacheRetention(settings, platform)).toEqual({
      enabled,
      current: "/w",
    });
  });

  it.each([
    [{ enabled: true, current: "/w" }, true],
    [{ enabled: false, current: "/w" }, false],
    [{ enabled: true, current: "/v" }, false],
  ])("compares retention %o: %s", (other, same) => {
    expect(sameCheckoutCacheRetention({ enabled: true, current: "/w" }, other)).toBe(same);
  });
});
