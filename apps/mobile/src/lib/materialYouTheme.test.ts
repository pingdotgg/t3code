import { describe, expect, it } from "vite-plus/test";

import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import type { MaterialYouPalette } from "./materialYouPalette";
import { materialYouPaletteToMobileThemeVariables } from "./materialYouTheme";

const palette: MaterialYouPalette = {
  primary: "#6750A4FF",
  onPrimary: "#FFFFFFFF",
  primaryContainer: "#EADDFFFF",
  onPrimaryContainer: "#21005DFF",
  inversePrimary: "#D0BCFFFF",
  secondaryContainer: "#E8DEF8FF",
  onSecondaryContainer: "#1D192BFF",
  tertiary: "#7D5260FF",
  tertiaryContainer: "#FFD8E4FF",
  onTertiaryContainer: "#31111DFF",
  surface: "#FFFBFEFF",
  onSurface: "#1C1B1FFF",
  onSurfaceVariant: "#49454FFF",
  surfaceContainer: "#F3EDF7FF",
  surfaceContainerHigh: "#ECE6F0FF",
  surfaceContainerHighest: "#E6E0E9FF",
  surfaceContainerLow: "#F7F2FAFF",
  surfaceContainerLowest: "#FFFFFFFF",
  errorContainer: "#F9DEDCFF",
  onErrorContainer: "#410E0BFF",
  outline: "#79747EFF",
  outlineVariant: "#CAC4D0FF",
  scrim: "#000000FF",
};

describe("Material You system colors", () => {
  it("overrides the selected theme without mutating its base variables", () => {
    const base = getMobileThemeRuntimeVariables("t3-code", "dark");
    const snapshot = { ...base };

    const variables = materialYouPaletteToMobileThemeVariables(palette, "dark", base);

    expect(base).toEqual(snapshot);
    expect(variables["--color-screen"]).toBe(palette.surface);
    expect(variables["--color-header"]).toBe(palette.surfaceContainerHigh);
    expect(variables["--color-primary"]).toBe(palette.primary);
    expect(variables["--color-placeholder"]).toBe("#1C1B1F9E");
  });

  it("uses the Messages-style RCS tones for sent messages", () => {
    const base = getMobileThemeRuntimeVariables("t3-code", "dark");
    const dark = materialYouPaletteToMobileThemeVariables(
      { ...palette, inversePrimary: "#A31D8DFF" },
      "dark",
      base,
    );
    const light = materialYouPaletteToMobileThemeVariables(
      { ...palette, inversePrimary: "#A31D8DFF" },
      "light",
      getMobileThemeRuntimeVariables("t3-code", "light"),
    );

    expect(dark["--color-user-bubble"]).toBe("#850073FF");
    expect(dark["--color-user-bubble-foreground"]).toBe("#FFD7EFFF");
    expect(light["--color-user-bubble"]).toBe(palette.primary);
    expect(light["--color-user-bubble-foreground"]).toBe(palette.onPrimary);
  });
});
