import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loadPreferenceForWeight, summarizeLoadPreferences } from "./LoadBalancingSettings";

const machines = [
  { environmentId: EnvironmentId.make("a"), label: "alvin" },
  { environmentId: EnvironmentId.make("b"), label: "bb-1" },
  { environmentId: EnvironmentId.make("c"), label: "ProMini" },
];

describe("loadPreferenceForWeight", () => {
  it("snaps legacy slider weights onto the four preferences", () => {
    expect(loadPreferenceForWeight(undefined)).toBe(50);
    expect(loadPreferenceForWeight(0)).toBe(0);
    expect(loadPreferenceForWeight(10)).toBe(25);
    expect(loadPreferenceForWeight(50)).toBe(50);
    expect(loadPreferenceForWeight(80)).toBe(100);
  });
});

describe("summarizeLoadPreferences", () => {
  it("is empty when every machine is at Normal", () => {
    expect(summarizeLoadPreferences(machines, { a: 50 })).toBeNull();
  });

  it("lists only the machines that differ from Normal, in list order", () => {
    expect(summarizeLoadPreferences(machines, { b: 100, c: 0 })).toBe(
      "bb-1 prefer · ProMini manual only",
    );
  });
});
