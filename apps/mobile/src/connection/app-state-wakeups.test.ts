import { describe, expect, it } from "@effect/vitest";

import {
  MOBILE_BACKGROUND_RECONNECT_AFTER_MS,
  mobileApplicationActiveWakeup,
  mobileSuspensionStartedAtMs,
} from "./app-state-wakeups";

describe("mobileApplicationActiveWakeup", () => {
  it("uses a fast probe after a short interruption", () => {
    expect(mobileApplicationActiveWakeup(null, 20_000)).toBe("application-active-probe");
    expect(
      mobileApplicationActiveWakeup(20_000, 20_000 + MOBILE_BACKGROUND_RECONNECT_AFTER_MS - 1),
    ).toBe("application-active-probe");
  });

  it("replaces the session after a meaningful background suspension", () => {
    expect(
      mobileApplicationActiveWakeup(20_000, 20_000 + MOBILE_BACKGROUND_RECONNECT_AFTER_MS),
    ).toBe("application-active-reconnect");
  });
});

describe("mobileSuspensionStartedAtMs", () => {
  it("starts the clock on inactive so a short permission sheet stays a probe", () => {
    const startedAtMs = mobileSuspensionStartedAtMs(null, "inactive", 20_000);
    expect(startedAtMs).toBe(20_000);
    expect(mobileApplicationActiveWakeup(startedAtMs, 20_500)).toBe("application-active-probe");
  });

  it("starts the clock on background and keeps the first stamp through inactive", () => {
    const afterBackground = mobileSuspensionStartedAtMs(null, "background", 20_000);
    expect(afterBackground).toBe(20_000);
    expect(mobileSuspensionStartedAtMs(afterBackground, "inactive", 25_000)).toBe(20_000);
  });

  it("clears the clock on active and ignores unknown states", () => {
    expect(mobileSuspensionStartedAtMs(20_000, "active", 25_000)).toBeNull();
    expect(mobileSuspensionStartedAtMs(20_000, "unknown", 25_000)).toBe(20_000);
    expect(mobileSuspensionStartedAtMs(null, "active", 20_000)).toBeNull();
  });
});
