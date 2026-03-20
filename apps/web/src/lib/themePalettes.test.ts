import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_PALETTE_ID, getThemePaletteCatalog } from "./themePalettes";

describe("getThemePaletteCatalog", () => {
  it("keeps built-in palettes ahead of custom themes", () => {
    const palettes = getThemePaletteCatalog([
      {
        id: "midnight-mint",
        label: "Midnight Mint",
        dark: {
          primary: "oklch(0.79 0.16 170)",
          ring: "oklch(0.79 0.16 170)",
        },
      },
    ]);

    expect(palettes[0]?.id).toBe(DEFAULT_THEME_PALETTE_ID);
    expect(palettes.at(-1)?.id).toBe("midnight-mint");
    expect(palettes.at(-1)?.source).toBe("custom");
  });

  it("merges custom palettes with the default token set for both modes", () => {
    const palette = getThemePaletteCatalog([
      {
        id: "midnight-mint",
        label: "Midnight Mint",
        dark: {
          primary: "oklch(0.79 0.16 170)",
        },
      },
    ]).find((candidate) => candidate.id === "midnight-mint");

    expect(palette).toBeDefined();
    expect(palette?.dark.primary).toBe("oklch(0.79 0.16 170)");
    expect(palette?.dark.background).toBeTruthy();
    expect(palette?.light.primary).toBeTruthy();
  });
});
