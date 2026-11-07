import { describe, expect, it } from "vite-plus/test";

import {
  assertSettingsSurfaceCoverage,
  SETTINGS_SECTIONS,
  settingsNavGroupsForSurface,
  settingsSection,
  settingsSectionsForSurface,
  type SettingsSectionId,
} from "./catalog.ts";

describe("settings catalog", () => {
  it("gives every section a unique id", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps web paths unique when present", () => {
    const paths = SETTINGS_SECTIONS.flatMap((section) =>
      section.webPath !== undefined ? [section.webPath] : [],
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lists mobile sections that web also owns for shared product settings", () => {
    const mobile = new Set(
      settingsSectionsForSurface("mobile", { secretsFeatureEnabled: true }).map(
        (section) => section.id,
      ),
    );
    for (const id of [
      "providers",
      "threads",
      "diffs",
      "browser",
      "devices",
      "access",
      "secrets",
    ] as const satisfies ReadonlyArray<SettingsSectionId>) {
      expect(mobile.has(id)).toBe(true);
      expect(settingsSection(id).surfaces).toContain("web");
    }
  });

  it("keeps keybindings off mobile", () => {
    expect(settingsSection("keybindings").surfaces).not.toContain("mobile");
  });

  it("omits secrets until the feature flag is on", () => {
    expect(settingsSectionsForSurface("mobile").some((section) => section.id === "secrets")).toBe(
      false,
    );
    expect(
      settingsSectionsForSurface("mobile", { secretsFeatureEnabled: true }).some(
        (section) => section.id === "secrets",
      ),
    ).toBe(true);
  });

  it("builds nav groups without empty headings", () => {
    const groups = settingsNavGroupsForSurface("web");
    expect(groups.map((group) => group.heading)).toEqual([
      null,
      "Agents",
      "Code",
      "Connections",
      null,
    ]);
    expect(groups[0]?.sections.map((section) => section.id)).toContain("general");
    expect(groups[1]?.sections.map((section) => section.id)).toContain("providers");
  });

  it("reports missing surface coverage", () => {
    const implemented = new Set<SettingsSectionId>(["general", "appearance"]);
    expect(assertSettingsSurfaceCoverage("mobile", implemented)).toContain("providers");
    expect(assertSettingsSurfaceCoverage("mobile", implemented)).not.toContain("keybindings");
  });
});
