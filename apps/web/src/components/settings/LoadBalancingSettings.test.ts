import { describe, expect, it } from "vite-plus/test";

import { loadPreferenceForWeight } from "./LoadBalancingSettings";

describe("loadPreferenceForWeight", () => {
  it("snaps legacy slider weights onto the four preferences", () => {
    expect(loadPreferenceForWeight(undefined)).toBe(50);
    expect(loadPreferenceForWeight(0)).toBe(0);
    expect(loadPreferenceForWeight(10)).toBe(25);
    expect(loadPreferenceForWeight(50)).toBe(50);
    expect(loadPreferenceForWeight(80)).toBe(100);
  });
});
