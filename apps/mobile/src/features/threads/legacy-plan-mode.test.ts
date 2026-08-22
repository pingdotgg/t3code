import { describe, expect, it } from "@effect/vitest";

import { resolveLegacyPlanModeEnabled } from "./legacy-plan-mode";

describe("resolveLegacyPlanModeEnabled", () => {
  it("stays disabled until an enabled preference has loaded", () => {
    expect(resolveLegacyPlanModeEnabled({ loaded: false, preference: true })).toBe(false);
    expect(resolveLegacyPlanModeEnabled({ loaded: true, preference: false })).toBe(false);
    expect(resolveLegacyPlanModeEnabled({ loaded: true, preference: true })).toBe(true);
  });
});
