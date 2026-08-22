import { describe, expect, it } from "@effect/vitest";

import {
  MOBILE_BACKGROUND_RECONNECT_AFTER_MS,
  mobileApplicationActiveWakeup,
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

  it("preserves a protected background connection regardless of elapsed time", () => {
    const protection = { serviceRunning: true, runtimeReady: true };

    expect(mobileApplicationActiveWakeup(null, 20_000, protection)).toBe(
      "application-active-preserved",
    );
    expect(
      mobileApplicationActiveWakeup(
        20_000,
        20_000 + MOBILE_BACKGROUND_RECONNECT_AFTER_MS * 10,
        protection,
      ),
    ).toBe("application-active-preserved");
  });

  it("keeps the existing fallback unless both native protection signals are healthy", () => {
    expect(
      mobileApplicationActiveWakeup(20_000, 20_000 + MOBILE_BACKGROUND_RECONNECT_AFTER_MS, {
        serviceRunning: true,
        runtimeReady: false,
      }),
    ).toBe("application-active-reconnect");
    expect(
      mobileApplicationActiveWakeup(20_000, 20_000 + MOBILE_BACKGROUND_RECONNECT_AFTER_MS, {
        serviceRunning: false,
        runtimeReady: true,
      }),
    ).toBe("application-active-reconnect");
  });
});
