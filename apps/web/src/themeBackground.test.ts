import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";

import {
  applyThemeBackground,
  resolveThemeBackgroundUrl,
  STANDALONE_SCENE_IDS,
  THEME_BACKGROUNDS,
} from "./themeBackground";
import { GROVE_THEME } from "@t3tools/shared/themePalettes";

describe("resolveThemeBackgroundUrl", () => {
  it("follows the active theme on auto", () => {
    expect(resolveThemeBackgroundUrl("auto", "grove")).toBe("/backgrounds/grove.webp");
  });

  it("stays clear on auto for themes without a scene", () => {
    expect(resolveThemeBackgroundUrl("auto", "my-custom-theme")).toBeNull();
    expect(resolveThemeBackgroundUrl("auto", null)).toBeNull();
  });

  it("keeps a picked scene regardless of the active theme", () => {
    expect(resolveThemeBackgroundUrl("ocean", "grove")).toBe("/backgrounds/ocean.webp");
    expect(resolveThemeBackgroundUrl("fjord", null)).toBe("/backgrounds/fjord.webp");
  });

  it("clears the scene on none and ignores unknown picks", () => {
    expect(resolveThemeBackgroundUrl("none", "grove")).toBeNull();
    expect(resolveThemeBackgroundUrl("nonexistent" as never, "grove")).toBeNull();
  });
});

describe("theme background assets", () => {
  it("ships a scene for every built-in theme plus the standalone library", () => {
    for (const themeId of BUILT_IN_THEME_IDS) {
      expect(THEME_BACKGROUNDS[themeId]).toMatch(/^\/backgrounds\/[a-z0-9-]+\.webp$/);
    }
    expect(Object.keys(THEME_BACKGROUNDS).sort()).toEqual(
      ["auto", "none", ...BUILT_IN_THEME_IDS, ...STANDALONE_SCENE_IDS].sort(),
    );
  });
});

describe("applyThemeBackground", () => {
  it("is a safe no-op without a document", () => {
    expect(() =>
      applyThemeBackground("/backgrounds/grove.webp", GROVE_THEME, "light"),
    ).not.toThrow();
    expect(() => applyThemeBackground(null, null, "dark")).not.toThrow();
  });
});
