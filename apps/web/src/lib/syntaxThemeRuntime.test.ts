import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { registerCustomTheme } = vi.hoisted(() => ({
  registerCustomTheme: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
  registerCustomTheme,
}));

import { applySyntaxThemePreview, resolveDiffThemeName } from "./syntaxThemeRuntime";
import { invalidateCustomThemes, THEME_PREVIEW_ID } from "../themePalette";

const TOKEN_COLORS = [
  {
    scope: "comment",
    settings: { foreground: "#6272a4" },
  },
];

describe("resolveDiffThemeName", () => {
  beforeEach(() => {
    registerCustomTheme.mockClear();
  });
  it("falls back to Pierre when a theme has no syntax payload", () => {
    expect(resolveDiffThemeName("grove", "dark")).toBe("pierre-dark");
    expect(resolveDiffThemeName("grove", "light")).toBe("pierre-light");
    expect(resolveDiffThemeName(null, "dark")).toBe("pierre-dark");
    expect(registerCustomTheme).not.toHaveBeenCalled();
  });

  it("registers custom tokenColors as t3-syntax-<id>-<appearance>", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () =>
          JSON.stringify([
            {
              id: "dracula",
              label: "Dracula",
              appearance: "dark",
              colors: { canvas: "#282a36" },
              syntax: { dark: { tokenColors: TOKEN_COLORS } },
            },
          ]),
        setItem: () => {},
      },
    });
    invalidateCustomThemes();

    expect(resolveDiffThemeName("dracula", "dark")).toBe("t3-syntax-dracula-dark");
    expect(resolveDiffThemeName("dracula", "light")).toBe("pierre-light");

    invalidateCustomThemes();
    vi.unstubAllGlobals();
  });

  it("uses preview syntax when the live editor is previewing", () => {
    applySyntaxThemePreview({ tokenColors: TOKEN_COLORS }, "dark");
    expect(resolveDiffThemeName(THEME_PREVIEW_ID, "dark")).toBe("t3-syntax-__preview-dark");
    expect(resolveDiffThemeName(THEME_PREVIEW_ID, "light")).toBe("pierre-light");
    applySyntaxThemePreview(undefined, "dark");
  });
});
