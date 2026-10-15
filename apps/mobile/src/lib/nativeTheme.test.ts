import { describe, expect, it } from "vite-plus/test";
import { getMobileThemeVariables, MOBILE_THEME_OPTIONS } from "./mobileTheme";
import { createNativeThemeColors } from "./nativeTheme";

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

const cases = MOBILE_THEME_OPTIONS.flatMap((theme) => {
  if (theme.id === "material-you") return [];
  const themeId = theme.id;
  return (["light", "dark"] as const).map((appearance) => ({
    label: theme.label,
    themeId,
    appearance,
  }));
});

describe("native theme colors", () => {
  it.each(cases)(
    "$label $appearance keeps native labels legible on every container",
    ({ themeId, appearance }) => {
      const colors = createNativeThemeColors(getMobileThemeVariables(themeId, appearance));
      for (const surface of [
        colors.surface,
        colors.surfaceContainer,
        colors.surfaceContainerHigh,
        colors.surfaceContainerHighest,
      ]) {
        expect(contrast(colors.onSurface, surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(colors.onPrimary, colors.primary)).toBeGreaterThanOrEqual(4.5);
      for (const color of Object.values(colors)) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    },
  );
});
