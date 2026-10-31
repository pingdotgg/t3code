import { describe, expect, it } from "vite-plus/test";

import {
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  T3_CHAT_THEME,
  themeColorToHex,
  type ThemeColors,
} from "../../themePalette";
import { clerkAppearance } from "./clerkAppearance";

function contrastRatio(first: string, second: string): number {
  const toRgb = (value: string) => {
    const hex = themeColorToHex(value)?.slice(1, 7);
    if (!hex) throw new Error(`Expected a theme color, received ${value}`);
    return [0, 1, 2].map(
      (channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16) / 255,
    );
  };
  const luminance = (value: string) =>
    toRgb(value)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

const builtInThemeModes = [
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
].flatMap((theme) =>
  [theme.colors, theme.variants?.dark].filter((colors): colors is ThemeColors => !!colors),
);

describe("clerkAppearance", () => {
  it("binds every Clerk color to a live theme variable", () => {
    const colors = Object.entries(clerkAppearance.variables).filter(([key]) =>
      key.startsWith("color"),
    );

    expect(colors.length).toBeGreaterThan(0);
    for (const [, value] of colors) {
      expect(value).toMatch(/^var\(--[a-z-]+\)$/);
    }
  });

  it.each(builtInThemeModes)("keeps Clerk text readable across a built-in palette", (colors) => {
    expect(clerkAppearance.variables).toMatchObject({
      colorForeground: "var(--contrast-foreground)",
      colorBackground: "var(--popover)",
      colorMutedForeground: "var(--contrast-muted-foreground)",
      colorMuted: "var(--popover)",
      colorInputForeground: "var(--contrast-foreground)",
      colorInput: "var(--secondary)",
      colorPrimary: "var(--contrast-strong-foreground)",
      colorPrimaryForeground: "var(--popover)",
    });
    expect(contrastRatio(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.mutedForeground, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.text, colors.secondary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.errorForeground, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.warningForeground, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
