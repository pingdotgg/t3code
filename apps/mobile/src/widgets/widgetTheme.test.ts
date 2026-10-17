import { describe, expect, it } from "vite-plus/test";
import { MOBILE_THEME_IDS } from "../lib/mobileTheme";
import { getMobileThemeRuntimeVariables } from "../lib/mobileThemeVariables";
import { createWidgetTheme } from "./widgetTheme";
import { subscriptionUsageTimeline } from "./subscriptionUsageSnapshot";

function contrastRatio(first: string, second: string) {
  const luminance = (color: string) => {
    if (!/^#[0-9a-f]{6}(?:ff)?$/i.test(color)) throw new Error(`Expected opaque hex: ${color}`);
    const linear = [1, 3, 5].map((offset) => {
      const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("saved widget appearance", () => {
  it.each(MOBILE_THEME_IDS)(
    "keeps the Android unfilled track visible for %s in both appearances",
    (themeId) => {
      const theme = createWidgetTheme("system", {
        light: getMobileThemeRuntimeVariables(themeId, "light", "android"),
        dark: getMobileThemeRuntimeVariables(themeId, "dark", "android"),
      });
      expect(contrastRatio(theme.light.track, theme.light.background)).toBeGreaterThanOrEqual(1.3);
      expect(contrastRatio(theme.dark.track, theme.dark.background)).toBeGreaterThanOrEqual(1.3);
    },
  );
  it.each([
    { appearance: "light", card: "#F3EDF7FF", foreground: "#1C1B1FFF" },
    { appearance: "dark", card: "#211F26FF", foreground: "#E6E0E9FF" },
  ] as const)(
    "keeps the track visible with resolved Material You $appearance colors",
    ({ appearance, card, foreground }) => {
      const variables = {
        ...getMobileThemeRuntimeVariables("material-you", appearance, "android"),
        "--color-card": card,
        "--color-foreground": foreground,
      };
      const theme = createWidgetTheme(appearance, { light: variables, dark: variables });
      expect(theme[appearance].track).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastRatio(theme[appearance].track, card)).toBeGreaterThanOrEqual(1.3);
    },
  );
  const palettes = {
    light: getMobileThemeRuntimeVariables("t3-chat", "light", "ios"),
    dark: getMobileThemeRuntimeVariables("t3-code", "dark", "ios"),
  };

  it.each(["light", "dark", "system"] as const)(
    "preserves %s mode and both app palettes across serialization and expiry",
    (mode) => {
      const theme = createWidgetTheme(mode, palettes);
      const snapshot = JSON.parse(
        JSON.stringify({
          checkedAt: 1,
          theme,
          providers: [
            {
              name: "Claude",
              detail: "Subscription remaining",
              windows: [{ label: "Weekly", remaining: 8, reset: "Tomorrow" }],
              expiresAt: 10,
              totalWindows: 1,
            },
          ],
        }),
      );
      const timeline = subscriptionUsageTimeline(snapshot, 1);
      expect(timeline).toHaveLength(2);
      expect(timeline[1]?.props.providers[0]?.windows).toEqual([]);
      for (const entry of timeline) {
        expect(entry.props.theme).toEqual(theme);
      }
    },
  );
});
