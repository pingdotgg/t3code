import { describe, expect, it } from "@effect/vitest";

import { makeNetworkPathTracker, observeNetworkPath } from "./network-path";

describe("observeNetworkPath", () => {
  it("ignores a repeated interface", () => {
    expect(observeNetworkPath("WIFI", "WIFI")).toEqual({ path: "WIFI", changed: false });
  });

  it("reports a Wi-Fi to cellular handoff", () => {
    expect(observeNetworkPath("WIFI", "CELLULAR")).toEqual({ path: "CELLULAR", changed: true });
  });

  it("adopts the first known interface without reporting a handoff", () => {
    expect(observeNetworkPath(null, "CELLULAR")).toEqual({ path: "CELLULAR", changed: false });
  });

  it("clears the baseline for a disconnected or indeterminate interface", () => {
    expect(observeNetworkPath("WIFI", "UNKNOWN")).toEqual({ path: null, changed: false });
    expect(observeNetworkPath("WIFI", undefined)).toEqual({ path: null, changed: false });
  });

  it("does not report a handoff across a connectivity outage", () => {
    const lost = observeNetworkPath("WIFI", undefined);
    expect(observeNetworkPath(lost.path, "CELLULAR")).toEqual({
      path: "CELLULAR",
      changed: false,
    });
  });
});

describe("makeNetworkPathTracker", () => {
  it("reports the first handoff after a seeded baseline", () => {
    const tracker = makeNetworkPathTracker();
    tracker.seed("WIFI");
    expect(tracker.observe("CELLULAR", true)).toBe(true);
  });

  it("ignores a seed that lost the race with a listener event", () => {
    const tracker = makeNetworkPathTracker();
    expect(tracker.observe("CELLULAR", true)).toBe(false);
    tracker.seed("WIFI");
    expect(tracker.observe("CELLULAR", true)).toBe(false);
  });

  it("holds a handoff that lands while inactive until the app is active", () => {
    const tracker = makeNetworkPathTracker();
    tracker.seed("WIFI");
    expect(tracker.observe("CELLULAR", false)).toBe(false);
    expect(tracker.activate()).toBe(true);
    expect(tracker.activate()).toBe(false);
  });

  it("does not wake on activation without a handoff", () => {
    const tracker = makeNetworkPathTracker();
    tracker.seed("WIFI");
    expect(tracker.observe("WIFI", false)).toBe(false);
    expect(tracker.activate()).toBe(false);
  });
});
