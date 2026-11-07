import { describe, expect, it } from "vite-plus/test";
import { assertSettingsSurfaceCoverage } from "@t3tools/client-runtime/settings/catalog";

import { WEB_IMPLEMENTED_SETTINGS_SECTIONS } from "./settingsSearch";

describe("web settings catalog parity", () => {
  it("implements every catalog section assigned to web", () => {
    expect(
      assertSettingsSurfaceCoverage("web", WEB_IMPLEMENTED_SETTINGS_SECTIONS, {
        secretsFeatureEnabled: true,
        includeSecondary: true,
      }),
    ).toEqual([]);
  });
});
