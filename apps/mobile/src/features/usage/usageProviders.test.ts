import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));

import { PROVIDER_LABEL, PROVIDER_ORDER } from "./usageProviders";

describe("mobile usage provider presentation", () => {
  it("includes Pi in charts and model breakdowns", () => {
    expect(PROVIDER_ORDER).toContain("pi");
    expect(PROVIDER_LABEL.pi).toBe("Pi Agent");
  });
});
