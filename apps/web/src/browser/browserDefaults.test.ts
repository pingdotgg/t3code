import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => settings.current,
  useClientSettings: () => undefined,
  ensureClientSettingsHydrated: () => Promise.resolve(),
}));

const { getBrowserDefaults } = await import("./browserDefaults");

const withDefaultProfile = (browserDefaultProfileId: string) => {
  settings.current = {
    browserDefaultViewport: { _tag: "fill" },
    browserDefaultZoomFactor: 1,
    browserDefaultAppearance: "system",
    browserAutoShowFloatingPreview: true,
    browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
    browserDefaultProfileId,
  };
  return getBrowserDefaults();
};

describe("getBrowserDefaults profile resolution", () => {
  it("keeps a configured persistent profile", () => {
    expect(withDefaultProfile("work").profileId).toBe("work");
  });

  it("falls back for an unknown profile", () => {
    expect(withDefaultProfile("deleted").profileId).toBe(DEFAULT_BROWSER_PROFILE_ID);
  });

  it("refuses incognito as the default", () => {
    // A stored incognito default would open every new tab into storage that is
    // discarded on close, and the settings list no longer offers it — so the
    // row badged "Default" must be the one tabs actually open under.
    expect(withDefaultProfile(INCOGNITO_BROWSER_PROFILE_ID).profileId).toBe(
      DEFAULT_BROWSER_PROFILE_ID,
    );
  });
});
