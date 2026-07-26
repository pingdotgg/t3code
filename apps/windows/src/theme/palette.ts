/**
 * The app's visual identity: the refined alpine-nature look built around
 * Dolomites photography. Direct port of
 * `apps/mac/Sources/SergeCodeMac/Theme/AlpineTheme.swift` — every constant
 * below is the same number, and `stableIndex` is the same FNV-1a hash, so a
 * thread seeded on macOS and the same thread seeded on Windows pick the same
 * gradient.
 *
 * This file holds the non-photo half: the accent color and the duotone
 * gradient washes used wherever a photo has not loaded yet (or the Unsplash
 * key is absent), so the app degrades to the same palette instead of gray
 * placeholders.
 */

export interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export interface GradientPair {
  readonly top: Rgb;
  readonly bottom: Rgb;
}

export function rgb(red: number, green: number, blue: number): Rgb {
  return { red, green, blue };
}

const clampChannel = (value: number): number => Math.min(255, Math.max(0, Math.round(value * 255)));

/** `#RRGGBB` for persistence (project prefs, palette manifests). */
export function hexString(color: Rgb): string {
  const channels = [color.red, color.green, color.blue]
    .map((channel) => clampChannel(channel).toString(16).padStart(2, "0").toUpperCase())
    .join("");
  return `#${channels}`;
}

/** Parses `#RRGGBB` / `RRGGBB`. Returns `undefined` for anything else. */
export function rgbFromHex(hex: string): Rgb | undefined {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  if (value.length !== 6 || !/^[0-9a-f]{6}$/i.test(value)) {
    return undefined;
  }
  const packed = Number.parseInt(value, 16);
  return {
    red: ((packed >> 16) & 0xff) / 255,
    green: ((packed >> 8) & 0xff) / 255,
    blue: (packed & 0xff) / 255,
  };
}

/** CSS color for an `Rgb`, optionally with alpha. */
export function cssColor(color: Rgb, alpha = 1): string {
  const channels = [color.red, color.green, color.blue].map(clampChannel).join(" ");
  return alpha >= 1 ? `rgb(${channels})` : `rgb(${channels} / ${alpha})`;
}

// MARK: - Nature palette

/**
 * Soft meadow sage — the stable app-wide tint. Scenery can still color its own
 * artwork and washes, but primary controls no longer change identity as the
 * selected thread's photograph changes.
 */
export const accent = rgb(0.57, 0.79, 0.64);

/** Deeper foliage, for high-contrast foregrounds on pastel surfaces. */
export const forest = rgb(0.08, 0.22, 0.14);

/** Pastel nature tones for secondary, semantic accents. */
export const meadow = rgb(0.47, 0.72, 0.55);
export const sky = rgb(0.57, 0.75, 0.78);
export const clay = rgb(0.82, 0.6, 0.49);
export const lichen = rgb(0.82, 0.76, 0.52);
export const lavender = rgb(0.69, 0.64, 0.76);

/**
 * Success tint for completion glyphs. The macOS token is appearance-aware
 * (`NSColor(name:)`); the app renders dark-only on both platforms, so the dark
 * branch is the live value and the light branch is kept for the settings
 * preview surfaces that do render light.
 */
export const statusSuccessDark = rgb(0.47, 0.72, 0.55);
export const statusSuccessLight = rgb(0.267, 0.541, 0.349);

/**
 * The user's message is a deep spruce panel — a solid, dark surface that
 * belongs to the app's always-dark chrome while staying in the accent's hue
 * family. Light prose sits on it at ~11:1 contrast.
 */
export const userBubbleFill = rgb(0.14, 0.26, 0.19);
/** Hairline edge for the bubble: a whisper of accent, not a glow. */
export const userBubbleStrokeAlpha = 0.22;

/**
 * Playful pastel ramp for reasoning-effort levels, calm → intense. Slot
 * indices line up with the macOS `EffortLevelStyle.slot`.
 */
export const effortLevelColors: readonly Rgb[] = [sky, meadow, lichen, clay, lavender];

/** Ramp color for a slot, clamped so out-of-range slots degrade to an edge. */
export function effortColor(slot: number): Rgb {
  const index = Math.min(Math.max(slot, 0), effortLevelColors.length - 1);
  return effortLevelColors[index] ?? accent;
}

/**
 * A restrained, squarer geometry scale for the app's custom surfaces. Pills
 * remain reserved for true tags and circular status marks.
 */
export const corners = {
  compact: 5,
  control: 8,
  card: 10,
  composer: 14,
  hero: 16,
} as const;

/**
 * Shared minimum height of the content-header bands: the chat identity header
 * and the inspector Activity header. Both pin to this so the divider under
 * each header stays horizontally aligned across the chat/inspector boundary.
 */
export const contentHeaderHeight = 61;

/**
 * Duotone washes sampled from Dolomites conditions: dawn limestone, glacier
 * melt, high meadow, larch dusk, scree, spruce shade.
 */
export const dolomitesGradientPairs: readonly GradientPair[] = [
  { top: rgb(0.93, 0.8, 0.71), bottom: rgb(0.56, 0.55, 0.62) },
  { top: rgb(0.73, 0.85, 0.87), bottom: rgb(0.42, 0.56, 0.64) },
  { top: rgb(0.72, 0.8, 0.58), bottom: rgb(0.36, 0.5, 0.4) },
  { top: rgb(0.89, 0.72, 0.51), bottom: rgb(0.47, 0.42, 0.5) },
  { top: rgb(0.82, 0.81, 0.78), bottom: rgb(0.52, 0.54, 0.55) },
  { top: rgb(0.55, 0.66, 0.56), bottom: rgb(0.25, 0.34, 0.32) },
];

/** A scenery palette as persisted in a set manifest. */
export interface SceneryPalette {
  readonly accentHex?: string | undefined;
  /** Each entry is `[darkBase, lighterWash]`. */
  readonly washes?: readonly (readonly string[])[] | undefined;
}

const FNV_OFFSET_BASIS = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x0000_0100_0000_01b3n;
const U64_MASK = 0xffff_ffff_ffff_ffffn;

/**
 * FNV-1a over UTF-8, reduced mod `count`.
 *
 * The macOS version accumulates in `UInt64` with wrapping multiply
 * (`hash &* prime`). `BigInt` masked to 64 bits is the exact same arithmetic;
 * a `Number`-based port cannot be, because the product overflows 2^53 on the
 * first byte. Swift's own `hashValue` is per-launch seeded and JS has the same
 * problem, which is why both sides hand-roll this: the assignment has to
 * survive a relaunch, and now also has to agree across the two platforms.
 */
export function stableIndex(seed: string, count: number): number {
  if (count <= 0) {
    return 0;
  }
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(seed)) {
    hash = (hash ^ BigInt(byte)) & U64_MASK;
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return Number(hash % BigInt(count));
}

function paletteGradientPairs(palette: SceneryPalette | undefined): GradientPair[] | undefined {
  const washes = palette?.washes;
  if (!washes) {
    return undefined;
  }
  const pairs: GradientPair[] = [];
  for (const pair of washes) {
    if (pair.length !== 2) {
      continue;
    }
    const darkBase = rgbFromHex(pair[0] ?? "");
    const lighterWash = rgbFromHex(pair[1] ?? "");
    if (darkBase && lighterWash) {
      // The manifest stores `[darkBase, lighterWash]`; gradients keep the
      // established light-top/dark-bottom direction.
      pairs.push({ top: lighterWash, bottom: darkBase });
    }
  }
  return pairs.length > 0 ? pairs : undefined;
}

/**
 * Deterministic gradient pair for a seed (thread/photo id): the same entity
 * always falls back to the same wash across launches.
 */
export function gradientPair(seed: string, palette?: SceneryPalette): GradientPair {
  const pairs = paletteGradientPairs(palette) ?? dolomitesGradientPairs;
  return pairs[stableIndex(seed, pairs.length)] ?? dolomitesGradientPairs[0]!;
}

/** `linear-gradient(...)` matching SwiftUI's topLeading → bottomTrailing. */
export function gradientCss(seed: string, palette?: SceneryPalette): string {
  const pair = gradientPair(seed, palette);
  return `linear-gradient(135deg, ${cssColor(pair.top)}, ${cssColor(pair.bottom)})`;
}

/**
 * Palette-colored edge wash for scenery wallpapers. A missing/malformed
 * palette preserves the original black/white treatment exactly.
 */
export function sceneryWash(
  seed: string,
  palette: SceneryPalette | undefined,
  colorScheme: "light" | "dark",
): Rgb {
  const pairs = paletteGradientPairs(palette);
  if (!pairs) {
    return colorScheme === "dark" ? rgb(0, 0, 0) : rgb(1, 1, 1);
  }
  const pair = pairs[stableIndex(seed, pairs.length)];
  if (!pair) {
    return colorScheme === "dark" ? rgb(0, 0, 0) : rgb(1, 1, 1);
  }
  return colorScheme === "dark" ? pair.bottom : pair.top;
}

/** The accent a scenery palette overrides, or the stable app accent. */
export function accentFor(palette?: SceneryPalette): Rgb {
  const hex = palette?.accentHex;
  if (!hex) {
    return accent;
  }
  return rgbFromHex(hex) ?? accent;
}

// MARK: - Mode tints

export type ThreadRuntimeMode = "approvalRequired" | "autoAcceptEdits" | "auto" | "fullAccess";
export type ThreadInteractionMode = "normal" | "plan" | "advisor";

/**
 * Semantic tint for the access level: warmer pastels ask for more caution,
 * cooler ones signal more autonomy.
 */
export function runtimeModeTint(mode: ThreadRuntimeMode): Rgb {
  switch (mode) {
    case "approvalRequired":
      return clay;
    case "autoAcceptEdits":
      return lichen;
    case "auto":
      return sky;
    case "fullAccess":
      return meadow;
  }
}

/**
 * Tint distinguishing plan/advisor modes from default; normal stays
 * unaccented so the quiet state reads as the absence of color.
 */
export function interactionModeTint(mode: ThreadInteractionMode): Rgb | undefined {
  switch (mode) {
    case "normal":
      return undefined;
    case "plan":
      return lavender;
    case "advisor":
      return lichen;
  }
}
