import { describe, expect, it } from "vite-plus/test";
import { assertSettingsSurfaceCoverage } from "@t3tools/client-runtime/settings/catalog";

import { MOBILE_IMPLEMENTED_SETTINGS_SECTIONS } from "./settings-catalog-coverage";

describe("mobile settings catalog parity", () => {
  it("implements every catalog section assigned to mobile", () => {
    expect(
      assertSettingsSurfaceCoverage("mobile", MOBILE_IMPLEMENTED_SETTINGS_SECTIONS, {
        secretsFeatureEnabled: true,
        includeSecondary: true,
      }),
    ).toEqual([]);
  });
});
