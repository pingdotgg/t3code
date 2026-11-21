import { describe, expect, it } from "@effect/vitest";

import { mobileApplicationActiveWakeup } from "./app-state-wakeups";

describe("mobileApplicationActiveWakeup", () => {
  it.each([
    ["inactive without background", null, 5_000, null],
    ["background just under 10 s", 0, 9_999, "application-active-probe"],
    ["background of 10 s or more", 0, 10_000, "application-active-long"],
  ] as const)("%s", (_case, backgroundedAtMs, activeAtMs, expected) => {
    expect(mobileApplicationActiveWakeup(backgroundedAtMs, activeAtMs)).toBe(expected);
  });
});
