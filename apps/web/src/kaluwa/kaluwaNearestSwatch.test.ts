import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KALUWA_LOOK } from "./kaluwaLook";
import { kaluwaAccentColorFor } from "./kaluwaAccent";
import { KALUWA_PRESET_IDS, KALUWA_SWATCH_SLOTS, kaluwaPalette } from "./kaluwaPalette";
import { kaluwaNearestSwatchSlot } from "./kaluwaNearestSwatch";

const palettes = KALUWA_PRESET_IDS.flatMap((preset) =>
  (["dark", "light"] as const).flatMap((scheme) =>
    (["luminous", "jewel", "muted"] as const).map((mood) => kaluwaPalette(preset, scheme, mood)),
  ),
);

describe("kaluwaNearestSwatchSlot", () => {
  it("maps the owner's old vivid green to a green swatch in every palette", () => {
    for (const palette of palettes) {
      expect(["moss", "sage"]).toContain(kaluwaNearestSwatchSlot("#25eb53", palette));
    }
  });

  it("maps the owner's old vivid red to a red swatch in every palette", () => {
    for (const palette of palettes) {
      expect(["clay", "rose"]).toContain(kaluwaNearestSwatchSlot("#de1d1d", palette));
    }
  });

  it("maps a swatch to itself", () => {
    for (const palette of palettes) {
      for (const slot of KALUWA_SWATCH_SLOTS) {
        if (slot === "accent") continue;
        expect(kaluwaNearestSwatchSlot(palette[slot], palette)).toBe(slot);
      }
    }
  });

  it("maps blues, violets and greys sensibly", () => {
    const palette = kaluwaPalette("ember", "dark", "luminous");
    expect(["steel", "slate"]).toContain(kaluwaNearestSwatchSlot("#2563eb", palette));
    expect(kaluwaNearestSwatchSlot("#8b5cf6", palette)).toBe("dusk");
    expect(["ash", "slate"]).toContain(kaluwaNearestSwatchSlot("#9ca3af", palette));
    expect(kaluwaNearestSwatchSlot("#f3f4f6", palette)).toBe("bone");
  });

  it("ignores a malformed colour", () => {
    expect(kaluwaNearestSwatchSlot("green", kaluwaPalette("ember", "dark", "luminous"))).toBeNull();
  });
});

describe("kaluwaAccentColorFor", () => {
  const look = {
    look: DEFAULT_KALUWA_LOOK,
    preset: undefined as never,
    scheme: "dark" as const,
    palette: kaluwaPalette("ember", "dark", "luminous"),
  };

  it("paints an off-palette accent as its nearest swatch with palette colours on", () => {
    expect(kaluwaAccentColorFor("#de1d1d", look)).toMatch(/^var\(--kaluwa-swatch-(clay|rose), #/);
  });

  it("keeps an off-palette accent with classic colours", () => {
    const classic = { ...look, look: { ...DEFAULT_KALUWA_LOOK, statusColors: "classic" as const } };
    expect(kaluwaAccentColorFor("#de1d1d", classic)).toBe("#de1d1d");
    const steel = look.palette.steel;
    expect(kaluwaAccentColorFor(steel, classic)).toBe(`var(--kaluwa-swatch-steel, ${steel})`);
  });
});
