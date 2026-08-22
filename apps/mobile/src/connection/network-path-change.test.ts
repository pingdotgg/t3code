import { describe, expect, it } from "@effect/vitest";

import {
  observeNetworkPath,
  seedNetworkPathBaseline,
  UNKNOWN_NETWORK_PATH,
} from "./network-path-change";

describe("network path change detection", () => {
  it("does not probe when the listener matches the seeded interface", () => {
    const seeded = seedNetworkPathBaseline(UNKNOWN_NETWORK_PATH, "WIFI");

    expect(observeNetworkPath(seeded, "WIFI")).toEqual({
      baseline: { known: true, type: "WIFI" },
      shouldProbe: false,
    });
  });

  it("probes when a known interface changes", () => {
    const seeded = seedNetworkPathBaseline(UNKNOWN_NETWORK_PATH, "WIFI");

    expect(observeNetworkPath(seeded, "CELLULAR").shouldProbe).toBe(true);
  });

  it("probes when the listener wins the race with the async seed", () => {
    const observed = observeNetworkPath(UNKNOWN_NETWORK_PATH, "CELLULAR");

    expect(observed.shouldProbe).toBe(true);
    expect(seedNetworkPathBaseline(observed.baseline, "WIFI")).toEqual({
      known: true,
      type: "CELLULAR",
    });
  });

  it("probes on the first known interface after an unknown observation", () => {
    const seeded = seedNetworkPathBaseline(UNKNOWN_NETWORK_PATH, "WIFI");
    const unknown = observeNetworkPath(seeded, null);

    expect(unknown.shouldProbe).toBe(false);
    expect(observeNetworkPath(unknown.baseline, "CELLULAR").shouldProbe).toBe(true);
  });
});
