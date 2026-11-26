import { THEME_COLOR_ROLES } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import { createVividThemeColors, isThemeColor, toCanonicalThemeColor } from "../themePalette";
import { buildKaluwaThemes } from "./kaluwaThemes";

const themes = buildKaluwaThemes({
  generate: createVividThemeColors,
  canonical: toCanonicalThemeColor,
});

describe("buildKaluwaThemes", () => {
  it("builds every preset but Kaluwa today, which stays the stock theme", () => {
    expect(themes.map((theme) => theme.id)).toEqual([
      "kaluwa-ember",
      "kaluwa-tide",
      "kaluwa-noir",
      "kaluwa-paper",
    ]);
  });

  it("gives each theme both schemes with every role a valid colour", () => {
    for (const theme of themes) {
      const other = theme.appearance === "dark" ? "light" : "dark";
      for (const colors of [theme.colors, theme.variants?.[other]]) {
        expect(colors).toBeDefined();
        for (const role of THEME_COLOR_ROLES) expect(isThemeColor(colors?.[role])).toBe(true);
      }
    }
  });

  it("keeps the preset's own colours over the generated ones", () => {
    const ember = themes.find((theme) => theme.id === "kaluwa-ember")!;
    expect(ember.appearance).toBe("dark");
    expect(ember.colors.canvas).toBe(toCanonicalThemeColor("#1d1c1b"));
    expect(ember.colors.messageAction).toBe(toCanonicalThemeColor("#f2683a"));
    expect(ember.variants?.light?.canvas).toBe(toCanonicalThemeColor("#f5f4f2"));
    const paper = themes.find((theme) => theme.id === "kaluwa-paper")!;
    expect(paper.appearance).toBe("light");
    expect(paper.variants?.dark).toBeDefined();
  });

  it("keeps Kaluwa's sidebar band", () => {
    expect(themes.every((theme) => theme.sidebarArtwork === true)).toBe(true);
  });
});
