import { describe, expect, it } from "vite-plus/test";
import { getMobileThemeRuntimeVariables } from "../lib/mobileThemeVariables";
import { createWidgetTheme } from "./widgetTheme";
import { subscriptionUsageTimeline } from "./subscriptionUsageSnapshot";

describe("saved widget appearance", () => {
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
        expect(entry.props.theme).toEqual({
          mode,
          light: {
            background: palettes.light["--color-card"],
            foreground: palettes.light["--color-foreground"],
            secondary: palettes.light["--color-foreground-secondary"],
            accent: palettes.light["--color-primary"],
            track: palettes.light["--color-subtle"],
            danger: palettes.light["--color-danger-foreground"],
          },
          dark: {
            background: palettes.dark["--color-card"],
            foreground: palettes.dark["--color-foreground"],
            secondary: palettes.dark["--color-foreground-secondary"],
            accent: palettes.dark["--color-primary"],
            track: palettes.dark["--color-subtle"],
            danger: palettes.dark["--color-danger-foreground"],
          },
        });
      }
    },
  );
});
