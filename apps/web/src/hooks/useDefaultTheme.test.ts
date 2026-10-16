import { describe, expect, it } from "vite-plus/test";

import { defaultThemeGeneration, defaultThemeToApply } from "./useDefaultTheme";

const BASE = {
  environmentId: "env-1",
  defaultTheme: "nightfall",
  defaultThemeSetAt: "2026-08-28T00:00:00.000Z",
  appliedGeneration: null,
  resolves: true,
} as const;

describe("default theme adoption", () => {
  it("applies a set this client has not seen", () => {
    expect(defaultThemeToApply(BASE)).toBe(
      defaultThemeGeneration(BASE.defaultTheme, BASE.defaultThemeSetAt),
    );
  });

  it("does not replay a generation it already applied", () => {
    const generation = defaultThemeGeneration(BASE.defaultTheme, BASE.defaultThemeSetAt);
    expect(defaultThemeToApply({ ...BASE, appliedGeneration: generation })).toBe(null);
  });

  it("applies the same theme again when the environment re-sets it", () => {
    const applied = defaultThemeGeneration(BASE.defaultTheme, "2026-08-28T00:00:00.000Z");
    const next = defaultThemeToApply({
      ...BASE,
      defaultThemeSetAt: "2026-08-29T00:00:00.000Z",
      appliedGeneration: applied,
    });
    expect(next).not.toBe(null);
    expect(next).not.toBe(applied);
  });

  it("falls back to once-per-value without a set time", () => {
    const generation = defaultThemeGeneration("nightfall", "");
    expect(defaultThemeToApply({ ...BASE, defaultThemeSetAt: "", appliedGeneration: null })).toBe(
      generation,
    );
    expect(
      defaultThemeToApply({ ...BASE, defaultThemeSetAt: "", appliedGeneration: generation }),
    ).toBe(null);
  });

  it("waits for a theme that has not arrived yet", () => {
    expect(defaultThemeToApply({ ...BASE, resolves: false })).toBe(null);
  });

  it("leaves a client alone with no environment or no theme set", () => {
    expect(defaultThemeToApply({ ...BASE, environmentId: null })).toBe(null);
    expect(defaultThemeToApply({ ...BASE, defaultTheme: "" })).toBe(null);
  });
});
