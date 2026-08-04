import { describe, expect, it } from "vite-plus/test";

import type { ProjectColorHue } from "@t3tools/contracts";

import {
  PROJECT_COLOR_PALETTE,
  defaultProjectColor,
  projectColorStyle,
  resolveProjectHue,
} from "./projectColor";

describe("PROJECT_COLOR_PALETTE", () => {
  it("offers ten distinct hues", () => {
    expect(PROJECT_COLOR_PALETTE).toHaveLength(10);
    expect(new Set(PROJECT_COLOR_PALETTE.map((entry) => entry.hue)).size).toBe(10);
  });

  it("uses unique ids and stays inside the hue circle", () => {
    expect(new Set(PROJECT_COLOR_PALETTE.map((entry) => entry.id)).size).toBe(10);
    for (const entry of PROJECT_COLOR_PALETTE) {
      expect(Number.isInteger(entry.hue)).toBe(true);
      expect(entry.hue).toBeGreaterThanOrEqual(0);
      expect(entry.hue).toBeLessThan(360);
    }
  });

  it("keeps neighbouring swatches apart", () => {
    // Adjacent swatches sit side by side in the picker, so a pair that reads as
    // one colour there is a real defect rather than a style quibble.
    const sorted = [...PROJECT_COLOR_PALETTE].sort((left, right) => left.hue - right.hue);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]!.hue - sorted[index - 1]!.hue).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("defaultProjectColor", () => {
  it("is stable for the same key", () => {
    // The whole point: a project keeps its colour across reloads and machines.
    expect(defaultProjectColor("env:/repo/alpha")).toEqual(defaultProjectColor("env:/repo/alpha"));
  });

  it("always returns a palette entry", () => {
    for (const key of ["", "a", "env:/repo/alpha", "a".repeat(500), "ΩΩΩ", "0"]) {
      expect(PROJECT_COLOR_PALETTE).toContain(defaultProjectColor(key));
    }
  });

  it("spreads sequential keys across the palette", () => {
    // Real project keys are near-identical paths, so a hash that collapses
    // them would hand a whole sidebar one colour.
    const used = new Set(
      Array.from({ length: 40 }, (_, index) => defaultProjectColor(`env:/repo/p${index}`).id),
    );
    expect(used.size).toBe(PROJECT_COLOR_PALETTE.length);
  });

  it("separates keys differing only in the last character", () => {
    expect(defaultProjectColor("env:/repo/t3code").id).not.toBe(
      defaultProjectColor("env:/repo/t3codf").id,
    );
  });
});

describe("resolveProjectHue", () => {
  const key = "env:/repo/alpha";

  it("falls back to the derived default when nothing is stored", () => {
    expect(resolveProjectHue(key, undefined)).toBe(defaultProjectColor(key).hue);
    expect(resolveProjectHue(key, {})).toBe(defaultProjectColor(key).hue);
  });

  it("prefers an explicit override", () => {
    expect(resolveProjectHue(key, { [key]: 42 as ProjectColorHue })).toBe(42);
  });

  it("honours a custom hue that is not in the palette", () => {
    // "Completely configurable" means the wheel, not just the ten swatches.
    const custom = 17 as ProjectColorHue;
    expect(PROJECT_COLOR_PALETTE.map((entry) => entry.hue)).not.toContain(custom);
    expect(resolveProjectHue(key, { [key]: custom })).toBe(custom);
  });

  it("ignores overrides belonging to other projects", () => {
    expect(resolveProjectHue(key, { "env:/repo/other": 42 as ProjectColorHue })).toBe(
      defaultProjectColor(key).hue,
    );
  });

  it("treats hue 0 as a real override rather than absent", () => {
    // A falsy-but-valid value: `??` is load-bearing here, `||` would drop it.
    expect(resolveProjectHue(key, { [key]: 0 as ProjectColorHue })).toBe(0);
  });
});

describe("projectColorStyle", () => {
  it("exposes the hue as a custom property", () => {
    expect(projectColorStyle(210 as ProjectColorHue)).toEqual({ "--project-hue": "210" });
  });
});
