import { describe, expect, it } from "@effect/vitest";

import { mobileApplicationActiveWakeup, mobileBackgroundIdleWakeup } from "./app-state-wakeups";

describe("mobileApplicationActiveWakeup", () => {
  it.each([
    ["inactive without background", null, 5_000, null],
    ["background just under 10 s", 0, 9_999, "application-active-probe"],
    ["background of 10 s or more", 0, 10_000, "application-active-long"],
  ] as const)("%s", (_case, backgroundedAtMs, activeAtMs, expected) => {
    expect(mobileApplicationActiveWakeup(backgroundedAtMs, activeAtMs)).toBe(expected);
  });
});

describe("mobileBackgroundIdleWakeup", () => {
  it.each([
    { appState: "background", enabled: true, expected: "application-suspended" },
    // The idle event was queued before the user came back.
    { appState: "active", enabled: true, expected: null },
    { appState: "inactive", enabled: true, expected: null },
    { appState: "background", enabled: false, expected: null },
  ] as const)(
    "$appState with Battery Saver $enabled → $expected",
    ({ appState, enabled, expected }) => {
      expect(mobileBackgroundIdleWakeup(appState, enabled)).toBe(expected);
    },
  );
});
