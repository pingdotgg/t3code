import { HTML_RENDER_DEFAULT_FONTS, type HtmlRenderTheme } from "@t3tools/shared/htmlRender";
import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
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

function setup(theme: ThemePreference, resolvedTheme: ThemeAppearance): Disposable {
  Object.assign(selection, { theme, resolvedTheme, themeHalves: null });
  return { [Symbol.dispose]: () => setEnvironmentThemes([]) };
}

async function readRenderTheme(): Promise<HtmlRenderTheme> {
  let theme: HtmlRenderTheme | undefined;
  function Probe() {
    const resolved = useHtmlRenderTheme();
    useEffect(() => {
      theme = resolved;
    }, [resolved]);
    return null;
  }
  await using _screen = await render(<Probe />);
  if (!theme) throw new Error("The HTML render theme was not resolved.");
  return theme;
}

describe("useHtmlRenderTheme", () => {
  for (const appearance of ["light", "dark"] as const) {
    it.each([appearance, ...BUILT_IN_THEME_IDS])(
      `injects hex colors for %s in ${appearance} mode`,
      async (preference) => {
        using _selection = setup(preference, appearance);

        const theme = await readRenderTheme();

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

  it("preserves alpha when converting a published palette", async () => {
    using _selection = setup("transparent", "dark");
    setEnvironmentThemes([
      {
        id: "transparent",
        label: "Transparent",
        appearance: "dark",
        colors: { ...getStandardThemeColors("dark"), accent: "oklch(0.5 0 0 / 0.5)" },
      },
    ]);

    const theme = await readRenderTheme();

    expect(theme.variables["--accent"]).toBe("#63636380");
    expect(theme.variables["--chart-1"]).toBe("#63636380");
  });
});
