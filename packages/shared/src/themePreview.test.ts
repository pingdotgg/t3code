import { describe, expect, it } from "@effect/vitest";

import {
  mixThemePreviewBase,
  STANDARD_THEME_PREVIEW_COLORS,
  THEME_PREVIEW_RENDER_SPECS,
} from "./themePreview.js";

describe("theme preview", () => {
  it("keeps the desktop preview geometry stable across clients", () => {
    expect(THEME_PREVIEW_RENDER_SPECS.light!.accent.center).toEqual([0.72, 0.22]);
    expect(THEME_PREVIEW_RENDER_SPECS.dark!.accent.middleOpacity).toBe(0.62);
    expect(THEME_PREVIEW_RENDER_SPECS.dark!.action.center).toEqual([0.82, 0.18]);
  });

  it("mixes the standard canvas bases in OKLab", () => {
    expect(mixThemePreviewBase(STANDARD_THEME_PREVIEW_COLORS.light!, "light")).toBe("#fdfdfd");
    expect(mixThemePreviewBase(STANDARD_THEME_PREVIEW_COLORS.dark!, "dark")).toBe("#0a0a0a");
  });
});
