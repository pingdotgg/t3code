import { describe, expect, it } from "vite-plus/test";

import { appLockExpired, isAppLockGracePeriodMs } from "./appLock";

describe("appLockExpired", () => {
  it("locks on any time away when the grace period is immediate", () => {
    expect(appLockExpired({ awaySince: 1_000, now: 1_000, gracePeriodMs: 0 })).toBe(true);
  });

  it("stays unlocked for a quick trip away within the grace period", () => {
    expect(appLockExpired({ awaySince: 1_000, now: 59_000, gracePeriodMs: 60_000 })).toBe(false);
  });

  it("locks once the time away reaches the grace period", () => {
    expect(appLockExpired({ awaySince: 1_000, now: 61_000, gracePeriodMs: 60_000 })).toBe(true);
  });

  it("locks when the clock moved backwards while away", () => {
    expect(appLockExpired({ awaySince: 10_000, now: 5_000, gracePeriodMs: 3_600_000 })).toBe(true);
  });
});

describe("isAppLockGracePeriodMs", () => {
  it("accepts only the offered grace periods", () => {
    expect(isAppLockGracePeriodMs(300_000)).toBe(true);
    expect(isAppLockGracePeriodMs(42)).toBe(false);
    expect(isAppLockGracePeriodMs("0")).toBe(false);
  });
});
