import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  DEFAULT_THEME_PALETTE,
  getThemePalette,
  getThemePalettePreviewColors,
  isThemePalette,
  THEME_PALETTES,
  type ThemePaletteColors,
} from "./themePalettes";
import { generateThemePalettesCss } from "./themePalettesCss";

const REQUIRED_COLOR_KEYS: ReadonlyArray<keyof ThemePaletteColors> = [
  "primary",
  "onPrimary",
  "secondary",
  "onSecondary",
  "tertiary",
  "onTertiary",
  "error",
  "surface",
  "onSurface",
  "surfaceVariant",
  "onSurfaceVariant",
  "outline",
];

describe("themePalettes", () => {
  it("provides unique ids", () => {
    expect(new Set(THEME_PALETTES.map((palette) => palette.id)).size).toBe(THEME_PALETTES.length);
  });

  it("includes all required colors for both light and dark modes", () => {
    for (const palette of THEME_PALETTES) {
      for (const mode of ["light", "dark"] as const) {
        const colors = palette[mode];
        for (const key of REQUIRED_COLOR_KEYS) {
          expect(colors[key]).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    }
  });

  it("exposes primary, secondary, and tertiary as preview colors", () => {
    for (const palette of THEME_PALETTES) {
      for (const mode of ["light", "dark"] as const) {
        const preview = getThemePalettePreviewColors(palette.id, mode);
        expect(preview).toEqual([
          palette[mode].primary,
          palette[mode].secondary,
          palette[mode].tertiary,
        ]);
      }
    }
  });

  it("validates ids and falls back to the default palette", () => {
    expect(isThemePalette("catppuccin")).toBe(true);
    expect(isThemePalette("unknown")).toBe(false);
    expect(getThemePalette(DEFAULT_THEME_PALETTE).id).toBe(DEFAULT_THEME_PALETTE);
    expect(getThemePalette("unknown" as never).id).toBe(DEFAULT_THEME_PALETTE);
  });

  it("generates CSS that contains every palette in both light and dark modes", () => {
    const css = generateThemePalettesCss();
    for (const palette of THEME_PALETTES) {
      expect(css).toContain(`[data-theme-palette="${palette.id}"]`);
      expect(css).toContain(`:root.dark[data-theme-palette="${palette.id}"]`);
    }
  });

  it("keeps the committed generated CSS in sync with the source data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const committed = yield* fs.readFileString(
        new URL("./themePalettes.css", import.meta.url).pathname,
      );
      const generated = generateThemePalettesCss();
      // The file system may or may not preserve a trailing newline; compare
      // content without trailing whitespace.
      expect(committed.trimEnd()).toBe(generated.trimEnd());
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));
});
