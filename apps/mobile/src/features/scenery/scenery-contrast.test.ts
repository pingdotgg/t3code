import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  compositeOver,
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  sceneryBackdrops,
  worstCaseContrast,
} from "./scenery-contrast";

/**
 * The chat palette lives in global.css (components consume it as uniwind
 * classes / `useThemeColor`), so the accessibility contract is asserted
 * against that file rather than a copy of the values.
 */
const THEME_CSS = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("../../../global.css", import.meta.url)),
  "utf8",
);

type Scheme = "light" | "dark";

function themeTokens(scheme: Scheme): ReadonlyMap<string, string> {
  const variant = new RegExp(String.raw`@variant ${scheme}\s*\{([\s\S]*?)\n {4}\}`).exec(THEME_CSS);
  if (!variant) {
    throw new Error(`global.css has no @variant ${scheme} block`);
  }
  const tokens = new Map<string, string>();
  for (const [, name, value] of variant[1]!.matchAll(/^\s*(--color-[\w-]+):\s*([^;]+);/gm)) {
    tokens.set(name!, value!.trim());
  }
  return tokens;
}

const THEME: Record<Scheme, ReadonlyMap<string, string>> = {
  light: themeTokens("light"),
  dark: themeTokens("dark"),
};

function token(scheme: Scheme, name: string): string {
  const value = THEME[scheme].get(name);
  if (value === undefined) {
    throw new Error(`global.css (${scheme}) is missing ${name}`);
  }
  return value;
}

/**
 * Fills components stack *on top of* a plate: the subagent row's state tint
 * (SubagentTaskRow `rowBackgroundClassName`), the session-exit rose tint, and
 * the fill behind a StatusPill. Each one drags the backdrop back toward the
 * text, so a plate token is only safe if it clears AA under every one of them.
 * The Tailwind-palette tints are spelled out here because they have no theme
 * token; keep them in step with the components that apply them.
 */
const PLATE_TINTS: Record<Scheme, ReadonlyArray<string>> = {
  light: [
    "rgba(76, 117, 92, 0.14)", // bg-accent-soft (running)
    "rgba(245, 158, 11, 0.08)", // bg-amber-500/8 (stalled)
    "rgba(16, 185, 129, 0.08)", // bg-emerald-500/8 (completed)
    "rgba(244, 63, 94, 0.08)", // bg-rose-500/8 (failed, session exit)
  ],
  dark: [
    "rgba(110, 154, 125, 0.16)",
    "rgba(245, 158, 11, 0.08)",
    "rgba(16, 185, 129, 0.10)",
    "rgba(244, 63, 94, 0.10)",
  ],
};

/** Layers between a photo pixel and the given content: scrim, then any plate. */
function layers(scheme: Scheme, plate?: string): ReadonlyArray<string> {
  const scrim = token(scheme, "--color-scenery-scrim");
  return plate === undefined ? [scrim] : [scrim, token(scheme, plate)];
}

/**
 * Every layer stack a plate-borne color can end up on: the bare plate, the
 * plate under each row tint, and either of those under a pill fill.
 */
function plateStacks(scheme: Scheme): ReadonlyArray<ReadonlyArray<string>> {
  const base = layers(scheme, "--color-scenery-plate");
  const pill = token(scheme, "--color-subtle-strong");
  return [base, ...PLATE_TINTS[scheme].map((tint) => [...base, tint])].flatMap((stack) => [
    stack,
    [...stack, pill],
  ]);
}

/** The contrast a plate color keeps no matter which tint/pill sits under it. */
function worstPlateContrast(scheme: Scheme, name: string): number {
  return plateStacks(scheme).reduce(
    (worst, stack) => Math.min(worst, worstCaseContrast(token(scheme, name), stack)),
    Number.POSITIVE_INFINITY,
  );
}

/** Opacity of a whole stack of translucent layers, 0 = photo untouched. */
function compositeAlpha(scheme: Scheme, names: ReadonlyArray<string>): number {
  return 1 - names.reduce((clear, name) => clear * (1 - parseCssColor(token(scheme, name)).a), 1);
}

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

describe("wcag primitives", () => {
  it("parses the color forms the theme uses", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#4c755c")).toEqual({ r: 76, g: 117, b: 92, a: 1 });
    expect(parseCssColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(() => parseCssColor("moss")).toThrow();
  });

  it("composites translucent layers in sRGB space", () => {
    const halfWhiteOverBlack = compositeOver(parseCssColor("rgba(255,255,255,0.5)"), {
      r: 0,
      g: 0,
      b: 0,
    });
    expect(halfWhiteOverBlack).toEqual({ r: 128, g: 128, b: 128 });
  });

  it("scores black on white at the WCAG maximum", () => {
    const black = parseCssColor("#000000");
    const white = parseCssColor("#ffffff");
    expect(relativeLuminance(black)).toBe(0);
    expect(relativeLuminance(white)).toBe(1);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
  });

  it("takes the worst of both photo extremes, not an average", () => {
    // A 50% black scrim can leave a mid-gray backdrop under a bright photo.
    const backdrops = sceneryBackdrops(["rgba(0,0,0,0.5)"]);
    expect(backdrops).toEqual([
      { r: 0, g: 0, b: 0 },
      { r: 128, g: 128, b: 128 },
    ]);
    // White text is fine over the black extreme and weak over the gray one.
    expect(worstCaseContrast("#ffffff", ["rgba(0,0,0,0.5)"])).toBeCloseTo(3.95, 1);
  });
});

describe("chat palette on the scenery wallpaper", () => {
  const schemes: ReadonlyArray<Scheme> = ["light", "dark"];

  describe.each(schemes)("%s", (scheme) => {
    it.each([
      "--color-scenery-foreground",
      "--color-scenery-foreground-strong",
      "--color-scenery-foreground-muted",
      "--color-scenery-link",
      "--color-scenery-skill",
    ])("keeps bare text at AA: %s", (name) => {
      expect(worstCaseContrast(token(scheme, name), layers(scheme))).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    });

    it("keeps bare icons at 3:1", () => {
      expect(
        worstCaseContrast(token(scheme, "--color-scenery-icon"), layers(scheme)),
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });

    it.each([
      "--color-scenery-plate-foreground",
      "--color-scenery-plate-foreground-muted",
      "--color-scenery-plate-danger",
      "--color-scenery-plate-success",
      "--color-scenery-plate-warning",
    ])("keeps plate text at AA under every row tint: %s", (name) => {
      expect(worstPlateContrast(scheme, name)).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it("keeps plate icons at 3:1 under every row tint", () => {
      expect(worstPlateContrast(scheme, "--color-scenery-plate-icon")).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    });

    it.each(["--color-scenery-code-foreground", "--color-scenery-code-muted"])(
      "keeps code text at AA: %s",
      (name) => {
        // A code fill appears both bare on the wallpaper (markdown fences) and
        // nested inside a plate (expanded log detail); the bare case is worse.
        expect(
          worstCaseContrast(token(scheme, name), layers(scheme, "--color-scenery-code")),
        ).toBeGreaterThanOrEqual(AA_TEXT);
      },
    );

    it("leaves the photo visible where prose sits on it", () => {
      // Prose is the bulk of the feed and only ever has the scrim over it.
      expect(compositeAlpha(scheme, ["--color-scenery-scrim"])).toBeLessThanOrEqual(0.65);
      // Plated rows are denser, so they wash the photo out further — but they
      // are still translucent, not opaque cards.
      expect(
        compositeAlpha(scheme, ["--color-scenery-scrim", "--color-scenery-plate"]),
      ).toBeLessThanOrEqual(0.9);
    });

    it("regresses the pre-SER-90 palette it replaced", () => {
      // The tokens the feed used to paint with: `--color-foreground-muted`
      // bare on the wallpaper, and body text under the old lighter scrims.
      const oldScrim = scheme === "light" ? "rgba(255,255,255,0.58)" : "rgba(0,0,0,0.5)";
      expect(worstCaseContrast(token(scheme, "--color-foreground-muted"), [oldScrim])).toBeLessThan(
        AA_TEXT,
      );
      expect(
        worstCaseContrast(token(scheme, "--color-scenery-foreground"), [oldScrim]),
      ).toBeLessThan(
        worstCaseContrast(token(scheme, "--color-scenery-foreground"), layers(scheme)),
      );
    });
  });
});
