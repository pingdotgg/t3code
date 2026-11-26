import { describe, expect, it } from "vite-plus/test";

import {
  KALUWA_PRESETS,
  KALUWA_PRESET_IDS,
  KALUWA_PROJECT_COLOR_SWATCHES,
  KALUWA_STATUS_SWATCHES,
  KALUWA_SWATCH_SLOTS,
  kaluwaPalette,
  kaluwaPaletteVariables,
  kaluwaPresetForThemeId,
  kaluwaSwatchSlotForHex,
  kaluwaThemeRoleColors,
  oklchToHex,
} from "./kaluwaPalette";

describe("kaluwaPalette", () => {
  // Reference values computed with the approved theme lab's own palette function.
  it("matches the theme lab for Ember, dark, Luminous", () => {
    expect(kaluwaPalette("ember", "dark", "luminous")).toEqual({
      accent: "#ff9360",
      clay: "#fd9783",
      ochre: "#efbe70",
      sand: "#d0c4a0",
      moss: "#b3d28e",
      sage: "#98d3ab",
      lagoon: "#73d1d6",
      steel: "#77c0f3",
      slate: "#acb9d5",
      dusk: "#b8a3f5",
      plum: "#dc9ad6",
      rose: "#f499aa",
      ash: "#9e958c",
      bone: "#cfc8bf",
    });
  });

  it("matches the theme lab for a light Muted and a light Jewel palette", () => {
    expect(kaluwaPalette("paper", "light", "muted").accent).toBe("#8e4931");
    expect(kaluwaPalette("paper", "light", "muted").bone).toBe("#47433e");
    expect(kaluwaPalette("today", "light", "jewel").sage).toBe("#016638");
    expect(kaluwaPalette("today", "light", "jewel").accent).toBe("#1245d2");
  });

  it("gives every preset, scheme and mood all 14 swatches as hex", () => {
    for (const preset of KALUWA_PRESET_IDS) {
      for (const scheme of ["dark", "light"] as const) {
        for (const mood of ["luminous", "jewel", "muted"] as const) {
          const palette = kaluwaPalette(preset, scheme, mood);
          expect(Object.keys(palette)).toEqual([...KALUWA_SWATCH_SLOTS]);
          for (const hex of Object.values(palette)) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("clamps out-of-gamut colours instead of overflowing", () => {
    expect(oklchToHex(1, 0, 0)).toBe("#ffffff");
    expect(oklchToHex(0, 0, 0)).toBe("#000000");
    expect(oklchToHex(0.7, 0.4, 140)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("swatch references", () => {
  it("maps every status and project colour to a real slot", () => {
    for (const slot of [
      ...Object.values(KALUWA_STATUS_SWATCHES),
      ...Object.values(KALUWA_PROJECT_COLOR_SWATCHES),
    ]) {
      expect(KALUWA_SWATCH_SLOTS).toContain(slot);
    }
    expect(KALUWA_STATUS_SWATCHES).toEqual({
      working: "steel",
      waiting: "ash",
      approval: "ochre",
      input: "dusk",
      failed: "clay",
      done: "sage",
    });
  });

  it("finds the slot of a hex picked from any palette, case-insensitively", () => {
    const ember = kaluwaPalette("ember", "dark", "luminous");
    expect(kaluwaSwatchSlotForHex(ember.steel)).toBe("steel");
    expect(kaluwaSwatchSlotForHex(ember.rose.toUpperCase())).toBe("rose");
    expect(kaluwaSwatchSlotForHex(kaluwaPalette("paper", "light", "muted").moss)).toBe("moss");
  });

  it("leaves a custom hex alone", () => {
    expect(kaluwaSwatchSlotForHex("#123456")).toBeNull();
  });

  it("emits one custom property per swatch", () => {
    const variables = kaluwaPaletteVariables(kaluwaPalette("tide", "dark", "luminous"));
    expect(variables).toHaveLength(14);
    expect(variables[0]).toEqual(["--kaluwa-swatch-accent", expect.stringMatching(/^#/)]);
  });
});

describe("presets", () => {
  it("resolves a theme id to its preset, and anything else to Kaluwa today", () => {
    expect(kaluwaPresetForThemeId("kaluwa-ember").id).toBe("ember");
    expect(kaluwaPresetForThemeId("kaluwa-paper").id).toBe("paper");
    expect(kaluwaPresetForThemeId("ember").id).toBe("today");
    expect(kaluwaPresetForThemeId(undefined).id).toBe("today");
  });

  it("maps a preset to theme roles the way the lab exported them", () => {
    const roles = kaluwaThemeRoleColors(KALUWA_PRESETS.ember, "dark");
    expect(roles.canvas).toBe("#1d1c1b");
    expect(roles.surfaceRaised).toBe("#161514");
    expect(roles.messageAction).toBe("#f2683a");
    expect(roles.messageActionForeground).toBe("#1c0b04");
    expect(roles.border).toBe("rgb(255 255 255 / 9%)");
    expect(roles.input).toBe("rgb(255 255 255 / 13.1%)");
    expect(roles.sidebarRowSelected).toBe("rgb(255 255 255 / 10%)");
    expect(roles.accentSurface).toBe("rgb(255 255 255 / 6%)");
    const light = kaluwaThemeRoleColors(KALUWA_PRESETS.paper, "light");
    expect(light.border).toBe("rgb(0 0 0 / 11%)");
    expect(light.text).toBe("#161513");
  });
});
