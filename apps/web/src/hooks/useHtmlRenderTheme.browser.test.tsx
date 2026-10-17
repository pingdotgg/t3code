import { HTML_RENDER_DEFAULT_FONTS, type HtmlRenderTheme } from "@t3tools/shared/htmlRender";
import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getStandardThemeColors,
  setEnvironmentThemes,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { useHtmlRenderTheme } from "./useHtmlRenderTheme";

const selection = vi.hoisted(() => ({
  theme: "ocean" as ThemePreference,
  resolvedTheme: "dark" as ThemeAppearance,
  themeHalves: null as ThemeHalves | null,
}));

vi.mock(import("./useTheme"), async (original) => ({
  ...(await original()),
  useTheme: (() => selection) as never,
}));

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  selection.themeHalves = null;
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  setEnvironmentThemes([]);
  vi.unstubAllGlobals();
});

function readRenderTheme(): HtmlRenderTheme {
  let theme: HtmlRenderTheme | undefined;
  function Probe() {
    const resolved = useHtmlRenderTheme();
    useEffect(() => {
      theme = resolved;
    }, [resolved]);
    return null;
  }
  act(() => root?.unmount());
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe />));
  if (!theme) throw new Error("The HTML render theme was not resolved.");
  return theme;
}

describe("useHtmlRenderTheme", () => {
  for (const appearance of ["light", "dark"] as const) {
    it.each([appearance, ...BUILT_IN_THEME_IDS])(
      `injects hex colors for %s in ${appearance} mode`,
      (preference) => {
        selection.theme = preference;
        selection.resolvedTheme = appearance;

        const theme = readRenderTheme();

        expect(theme.appearance).toBe(appearance);
        for (const [variable, value] of Object.entries(theme.variables)) {
          if (variable === "--radius" || variable.startsWith("--font-")) continue;
          expect(value, variable).toMatch(/^#[\da-f]{6}(?:[\da-f]{2})?$/i);
        }
        expect(theme.variables["--font-sans"]).toBe(HTML_RENDER_DEFAULT_FONTS.sans);
        expect(theme.variables["--font-mono"]).toBe(HTML_RENDER_DEFAULT_FONTS.mono);
        expect(theme.variables["--radius"]).toBe("0.625rem");
      },
    );
  }

  it("preserves alpha when converting a published palette", () => {
    setEnvironmentThemes([
      {
        id: "transparent",
        label: "Transparent",
        appearance: "dark",
        colors: { ...getStandardThemeColors("dark"), accent: "oklch(0.5 0 0 / 0.5)" },
      },
    ]);
    selection.theme = "transparent";
    selection.resolvedTheme = "dark";

    const theme = readRenderTheme();

    expect(theme.variables["--accent"]).toBe("#63636380");
    expect(theme.variables["--chart-1"]).toBe("#63636380");
  });
});
