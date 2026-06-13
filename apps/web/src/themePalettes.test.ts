import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_THEME_PALETTE,
  getThemePalette,
  isThemePalette,
  THEME_PALETTES,
} from "./themePalettes";

describe("themePalettes", () => {
  it("provides unique ids and complete light/dark previews", () => {
    expect(new Set(THEME_PALETTES.map((palette) => palette.id)).size).toBe(THEME_PALETTES.length);
    for (const palette of THEME_PALETTES) {
      expect(palette.dark).toHaveLength(4);
      expect(palette.light).toHaveLength(4);
    }
  });

  it("validates ids and falls back to the default palette", () => {
    expect(isThemePalette("catppuccin")).toBe(true);
    expect(isThemePalette("unknown")).toBe(false);
    expect(getThemePalette(DEFAULT_THEME_PALETTE).id).toBe(DEFAULT_THEME_PALETTE);
  });
});
