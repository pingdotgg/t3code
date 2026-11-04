import { describe, expect, it } from "@effect/vitest";

import {
  MOBILE_LONG_BACKGROUND_AFTER_MS,
  makeApplicationActiveWakeups,
  mobileApplicationActiveWakeup,
} from "./app-state-wakeups";

describe("mobileApplicationActiveWakeup", () => {
  it("uses a fast probe after a short interruption", () => {
    expect(mobileApplicationActiveWakeup(null, 20_000)).toBe("application-active-probe");
    expect(
      mobileApplicationActiveWakeup(20_000, 20_000 + MOBILE_LONG_BACKGROUND_AFTER_MS - 1),
    ).toBe("application-active-probe");
  });

  it("replaces the session after a meaningful background suspension", () => {
    expect(mobileApplicationActiveWakeup(20_000, 20_000 + MOBILE_LONG_BACKGROUND_AFTER_MS)).toBe(
      "application-active-long",
    );
  });
});

describe("makeApplicationActiveWakeups", () => {
  it("replaces the session after a screen lock whose background event arrives on resume", () => {
    const wakeupFor = makeApplicationActiveWakeups("active", 0);

    // JS handles `inactive` at the lock, is suspended for minutes, then
    // receives the queued `background` just before `active`.
    expect(wakeupFor("inactive", 1_000)).toBeUndefined();
    expect(wakeupFor("background", 181_000)).toBeUndefined();
    expect(wakeupFor("active", 181_010)).toBe("application-active-long");
  });

  it("replaces the session after a long inactive spell with no background event", () => {
    const wakeupFor = makeApplicationActiveWakeups("active", 0);

    wakeupFor("inactive", 1_000);
    expect(wakeupFor("active", 1_000 + MOBILE_LONG_BACKGROUND_AFTER_MS)).toBe(
      "application-active-long",
    );
  });

  it("probes after a short interruption and times each absence on its own", () => {
    const wakeupFor = makeApplicationActiveWakeups("active", 0);

    wakeupFor("inactive", 1_000);
    expect(wakeupFor("active", 3_000)).toBe("application-active-probe");
    wakeupFor("background", 60_000);
    expect(wakeupFor("active", 62_000)).toBe("application-active-probe");
  });

  it("times a launch into the background from launch", () => {
    const wakeupFor = makeApplicationActiveWakeups("background", 0);

    expect(wakeupFor("active", MOBILE_LONG_BACKGROUND_AFTER_MS)).toBe("application-active-long");
  });
});
