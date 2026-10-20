import { describe, expect, it } from "vite-plus/test";
import { Hct, SchemeTonalSpot, argbFromHex, hexFromArgb } from "@material/material-color-utilities";

import { MOBILE_THEME_IDS } from "../../lib/mobileTheme";
import { getMobileThemeRuntimeVariables } from "../../lib/mobileThemeVariables";
import { materialYouPaletteToMobileThemeVariables } from "../../lib/materialYouTheme.android";
import type { MaterialYouPalette } from "../../lib/materialYouPalette";
import { androidWorkspaceNavigationColors } from "./android-workspace-navigation-colors";

function luminance(hex: string) {
  const channels = hex
    .slice(1, 7)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(first: string, second: string) {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function expectVisibleSelection(colors: ReturnType<typeof androidWorkspaceNavigationColors>) {
  expect(contrast(colors.indicatorColor, colors.containerColor)).toBeGreaterThanOrEqual(1.5);
  for (const surface of [colors.containerColor, colors.indicatorColor]) {
    expect(contrast(colors.selectedColor, surface)).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast(colors.unselectedColor, colors.containerColor)).toBeGreaterThanOrEqual(4.5);
}

describe("Android workspace navigation colors", () => {
  it.each(MOBILE_THEME_IDS)(
    "keeps %s selection visible in both navigation positions",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const variables = getMobileThemeRuntimeVariables(themeId, appearance, "android");
        const snapshot = { ...variables };
        for (const rail of [false, true]) {
          expectVisibleSelection(androidWorkspaceNavigationColors(variables, rail));
        }
        expect(variables).toEqual(snapshot);
      }
    },
  );

  it.each(["#6750a4", "#006a6a", "#9c4146"])(
    "keeps Material You selection visible for system seed %s",
    (seed) => {
      for (const appearance of ["light", "dark"] as const) {
        const scheme = new SchemeTonalSpot(
          Hct.fromInt(argbFromHex(seed)),
          appearance === "dark",
          0,
        );
        const roles = [
          "primary",
          "onPrimary",
          "primaryContainer",
          "onPrimaryContainer",
          "inversePrimary",
          "secondaryContainer",
          "onSecondaryContainer",
          "tertiary",
          "tertiaryContainer",
          "onTertiaryContainer",
          "surface",
          "onSurface",
          "onSurfaceVariant",
          "surfaceContainer",
          "surfaceContainerHigh",
          "surfaceContainerHighest",
          "surfaceContainerLow",
          "surfaceContainerLowest",
          "errorContainer",
          "onErrorContainer",
          "outline",
          "outlineVariant",
          "scrim",
        ] as const satisfies ReadonlyArray<keyof MaterialYouPalette>;
        const palette = Object.fromEntries(
          roles.map((role) => [role, `${hexFromArgb(scheme[role])}ff`]),
        ) as Record<(typeof roles)[number], string>;
        const variables = materialYouPaletteToMobileThemeVariables(
          palette,
          appearance,
          getMobileThemeRuntimeVariables("material-you", appearance, "android"),
        );
        for (const rail of [false, true]) {
          expectVisibleSelection(androidWorkspaceNavigationColors(variables, rail));
        }
      }
    },
  );

  it("preserves an already visible tonal fill", () => {
    const variables = getMobileThemeRuntimeVariables("t3-chat", "light", "android");
    const colors = androidWorkspaceNavigationColors(
      { ...variables, "--color-secondary": "#e091cf" },
      true,
    );
    expect(colors.indicatorColor).toBe("#e091cf");
    expectVisibleSelection(colors);
  });
});
