import { describe, expect, it } from "@effect/vitest";

import { homeKey, isCheckoutCachePath } from "./checkoutCacheSites.ts";

describe("checkout cache sites", () => {
  it("keys each T3 state dir by its real path", () => {
    expect(homeKey("/home/a/.t3/userdata")).toMatch(/^[0-9a-f]{16}$/);
    expect(homeKey("/home/a/.t3/userdata")).toBe(homeKey("/home/a/.t3/userdata"));
    expect(homeKey("/home/a/.t3/userdata")).not.toBe(homeKey("/home/a/.t3/dev"));
  });

  it.each([
    ["/w/.t3-checkout-cache", false, true],
    ["/w/.t3-checkout-cache/", false, true],
    ["/w/.t3-checkout-cache/k/bucket/entry/files", false, true],
    // Any location's reserved folder, current, previous or nested, without knowing the roots.
    ["/elsewhere/old/.t3-checkout-cache/k", false, true],
    ["C:\\w\\.T3-Checkout-Cache\\k", true, true],
    ["/w/.T3-Checkout-Cache/k", false, false],
    ["/w/.t3-checkout-cache-old/k", false, false],
    ["/w/.t3-checkout-cachex", false, false],
    ["/w/x.t3-checkout-cache/k", false, false],
    ["/w/repo/branch", false, false],
    ["/t3/caches/worktree-checkouts", false, true],
    ["/t3/caches/worktree-checkouts/bucket/entry", false, true],
    ["/t3/caches/worktree-checkouts.trash-1/bucket", false, true],
    ["/t3/caches/worktree-checkouts.probe-2", false, true],
    ["/T3/Caches/Worktree-Checkouts/bucket", true, true],
    ["/t3/caches/worktree-checkouts-old", false, false],
    ["/t3/caches", false, false],
  ] as const)("treats %s as cache (fold %s): %s", (candidate, caseFold, expected) => {
    expect(
      isCheckoutCachePath(candidate, { homeCacheDir: "/t3/caches/worktree-checkouts", caseFold }),
    ).toBe(expected);
  });
});
