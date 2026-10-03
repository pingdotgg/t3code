import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PREVIEW_URL_MAX_LENGTH,
} from "@t3tools/contracts";

import { ensureClientSettingsHydrated } from "~/hooks/useSettings";

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => settings.current,
  useClientSettings: () => undefined,
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
}));

const { browserDefaultOpenUrl, getBrowserDefaults, resolveBrowserDefaults } =
  await import("./browserDefaults");

const withDefaultProfile = (browserDefaultProfileId: string) => {
  settings.current = {
    browserDefaultViewport: { _tag: "fill" },
    browserDefaultZoomFactor: 1,
    browserDefaultAppearance: "system",
    browserAutoShowFloatingPreview: true,
    browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
    browserDefaultProfileId,
    browserDefaultHomepage: "",
  };
  return getBrowserDefaults();
};

const withHomepage = (browserDefaultHomepage: string) => {
  withDefaultProfile("work");
  settings.current.browserDefaultHomepage = browserDefaultHomepage;
  return browserDefaultOpenUrl(getBrowserDefaults());
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

describe("browserDefaultOpenUrl", () => {
  it("opens a blank tab when no homepage is set", () => {
    expect(withHomepage("")).toBeUndefined();
  });

  it("normalizes the stored homepage like a typed URL", () => {
    expect(withHomepage("example.com")).toBe("https://example.com/");
    expect(withHomepage("localhost:5173")).toBe("http://localhost:5173/");
  });

  it.each([
    "ftp://example.com",
    "two words",
    `https://example.com/${"a".repeat(PREVIEW_URL_MAX_LENGTH)}`,
  ])("opens a blank tab for an unusable stored homepage", (stored) => {
    expect(withHomepage(stored)).toBeUndefined();
  });
});

describe("resolveBrowserDefaults", () => {
  it("rejects failed reads and uses the saved profile after a successful retry", async () => {
    withDefaultProfile("work");
    settings.current.browserDefaultZoomFactor = 1.25;
    settings.current.browserDefaultAppearance = "dark";
    settings.current.browserDefaultHomepage = "example.com";
    const failure = new Error("Settings read failed");
    vi.mocked(ensureClientSettingsHydrated).mockRejectedValueOnce(failure);

    await expect(resolveBrowserDefaults()).rejects.toBe(failure);
    await expect(resolveBrowserDefaults()).resolves.toMatchObject({
      viewport: { _tag: "fill" },
      zoomFactor: 1.25,
      appearance: "dark",
      autoShowFloatingPreview: true,
      profileId: "work",
      homepage: "https://example.com/",
    });
  });
});
