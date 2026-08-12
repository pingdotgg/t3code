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

function mixThemeColors(first: string, second: string, firstWeight: number): string {
  const channels = [first, second].map((value) => {
    const hex = themeColorToHex(value)?.slice(1, 7);
    if (!hex) throw new Error(`Expected a theme color, received ${value}`);
    return [0, 1, 2].map((channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16));
  });
  const mixed = channels[0]!.map((channel, index) =>
    Math.round(channel * firstWeight + channels[1]![index]! * (1 - firstWeight)),
  );
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
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
  it("maps theme colors without overriding Clerk's component structure", () => {
    expect(clerkAppearance).toEqual({
      variables: {
        colorPrimary: "var(--update-foreground)",
        colorPrimaryForeground: "var(--card)",
        colorDanger: "var(--error)",
        colorSuccess: "var(--success)",
        colorWarning: "var(--warning)",
        colorNeutral: "var(--foreground)",
        colorForeground: "var(--foreground)",
        colorMuted: "color-mix(in srgb, var(--card) 98%, var(--foreground))",
        colorMutedForeground: "var(--muted-foreground)",
        colorBackground: "var(--card)",
        colorInputForeground: "var(--foreground)",
        colorInput: "var(--secondary)",
        colorRing: "var(--ring)",
      },
      elements: {
        formFieldErrorText: { color: "var(--error-foreground)" },
        formFieldWarningText: { color: "var(--warning-foreground)" },
        formFieldSuccessText: { color: "var(--success-foreground)" },
        otpCodeFieldErrorText: { color: "var(--error-foreground)" },
        otpCodeFieldSuccessText: { color: "var(--success-foreground)" },
      },
    });
  });

  it.each(builtInThemeModes)("keeps Clerk text readable across a built-in palette", (colors) => {
    const mutedSurface = mixThemeColors(colors.surface, colors.text, 0.98);

    expect(contrastRatio(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.mutedForeground, mutedSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.text, colors.secondary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.updateForeground, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.errorForeground, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.warningForeground, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
