import { describe, expect, it } from "vite-plus/test";

import indexHtml from "../../index.html?raw";
import {
  DEFAULT_THEME_PALETTE,
  THEME_PALETTES,
  THEME_PALETTE_IDS,
  isThemePalette,
  normalizeThemePalette,
  themePaletteDescriptor,
} from "./themePalettes";

describe("theme palettes", () => {
  it("describes every palette id exactly once", () => {
    expect(THEME_PALETTES.map((entry) => entry.id)).toEqual([...THEME_PALETTE_IDS]);
  });

  it("keeps the default palette on the pierre syntax themes", () => {
    // Changing these would change how code blocks and diffs look out of the
    // box, which the palette work is specifically meant not to do.
    expect(themePaletteDescriptor(DEFAULT_THEME_PALETTE).syntax).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });
  });

  it("falls back to the default palette for unknown values", () => {
    expect(normalizeThemePalette("not-a-palette")).toBe(DEFAULT_THEME_PALETTE);
    expect(normalizeThemePalette(null)).toBe(DEFAULT_THEME_PALETTE);
    expect(isThemePalette("midnight")).toBe(true);
    expect(isThemePalette("not-a-palette")).toBe(false);
  });

  it("matches the palette allowlist hardcoded in the pre-boot script", () => {
    // index.html sets data-theme-palette before React boots and cannot import
    // this module, so its literal list is duplicated. If they disagree, a
    // palette either flashes the default on load or is rejected outright.
    const match = /const PALETTES = \[([^\]]*)\];/.exec(indexHtml);
    expect(match, "PALETTES allowlist not found in index.html").not.toBeNull();
    const listed = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(([, id]) => id);
    expect(listed).toEqual([...THEME_PALETTE_IDS]);
  });
});

// Not asserted here: that index.css carries a `[data-theme-palette="<id>"]`
// seed block for every non-default palette. Importing the stylesheet with
// `?raw` yields an empty string because the Tailwind plugin claims `.css`
// before the raw loader runs, and a test that cannot see its input is worse
// than no test. A missing seed block is caught by eye instead: the palette
// falls back to the @property initial values and renders as plain neutrals.
