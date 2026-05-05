import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_PALETTE } from "@t3tools/contracts/settings";

import {
  getThemePaletteCustomProperties,
  normalizeThemePalette,
  normalizeThemePaletteColor,
} from "./themePalette";

describe("themePalette", () => {
  it("normalizes valid hex colors and rejects invalid input", () => {
    expect(normalizeThemePaletteColor("  #Aa33f0 ")).toBe("#aa33f0");
    expect(normalizeThemePaletteColor("#abc")).toBeUndefined();
    expect(normalizeThemePaletteColor("rebeccapurple")).toBeUndefined();
  });

  it("generates CSS seed variables from selected colors", () => {
    const properties = getThemePaletteCustomProperties({
      primaryColor: "#ff0000",
      neutralColor: "#336699",
    });

    expect(properties).toEqual({
      "--theme-primary-seed": "#ff0000",
      "--theme-neutral-seed": "#336699",
    });
  });

  it("falls back to the default palette when persisted values are malformed", () => {
    const palette = normalizeThemePalette({
      primaryColor: "bad",
      neutralColor: "also-bad",
    });

    expect(palette).toEqual(DEFAULT_THEME_PALETTE);
  });
});
