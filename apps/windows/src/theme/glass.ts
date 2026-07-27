/**
 * How the window's layers stack over the desktop for a given scenery
 * translucency `t`. Direct port of
 * `apps/mac/Sources/SergeCodeMac/Theme/GlassLayering.swift`, including the
 * invariant that makes the slider honest.
 *
 * Bottom to top:
 *  1. **system backdrop** — the desktop, blurred by the compositor. macOS uses
 *     a behind-window `NSVisualEffectView`; Windows 11 uses a DWM system
 *     backdrop (Mica / Mica Alt / Acrylic, see `src-tauri/src/window.rs`).
 *     This is the only layer that differs between the platforms.
 *  2. **window plate** — flat window tone that solidifies the whole window
 *     toward the opaque end of the slider
 *  3. **scenery photo** — the location image
 *  4. **legibility wash** — flat tone over the photo so primary text stays
 *     readable on top (long-form text never sits on glass, so the wash is what
 *     carries its contrast)
 *  5. **chrome glass** — cards, composer, toolbar
 *
 * The invariant: **photo + wash composite to exactly `t`**, so `1 - t` of the
 * desktop reaches the user. The photo therefore gives up whatever alpha the
 * wash takes — hence `photoOpacity` solving the over-composite for the
 * leftover. Above `PLATE_START` the plate deliberately breaks the invariant
 * upward: that band is the "make it solid" end of the slider, landing fully
 * opaque at `1.0`.
 *
 * Two traps this encodes, both of which silently made the macOS window opaque
 * before and would do the same here:
 *
 * - The window plate is a *window-wide* layer, so it also sits under the
 *   scenery. Any alpha it spends is alpha the desktop can never reach — it
 *   stays at zero through the glass band and only ramps in above
 *   `PLATE_START`.
 * - Fading a stack of two opaque layers separately (a gradient fallback and
 *   the photo above it) composites them *both*, so the result covers far more
 *   than the requested alpha. The scenery view must flatten first — SwiftUI
 *   calls `.compositingGroup()`; the CSS port needs `isolation: isolate` on
 *   the scenery element and a single `opacity` on that group, never one per
 *   child.
 */

/** Scenery photo / glass solidity, as persisted in the scenery settings. */
export const TRANSLUCENCY_RANGE = { lowerBound: 0.5, upperBound: 1 } as const;
export const DEFAULT_TRANSLUCENCY = 0.85;

/**
 * Translucency at which the window plate starts solidifying. Below this the
 * window is pure backdrop plus the scene; above it the plate ramps in so
 * `1.0` is the fully solid window.
 */
export const PLATE_START = DEFAULT_TRANSLUCENCY;

export function clampTranslucency(value: number): number {
  if (Number.isNaN(value)) {
    return DEFAULT_TRANSLUCENCY;
  }
  return Math.min(Math.max(value, TRANSLUCENCY_RANGE.lowerBound), TRANSLUCENCY_RANGE.upperBound);
}

/**
 * Flat wash over the chat wallpaper. Dark mode pulls toward black, light mode
 * toward white — enough to keep primary/secondary text legible over a bright
 * sky.
 */
export function chatWashBase(colorScheme: "light" | "dark"): number {
  return colorScheme === "dark" ? 0.5 : 0.58;
}

/** Wash at the top/bottom edges of the empty-state hero. */
export const HERO_WASH_BASE_TOP = 0.1;
export const HERO_WASH_BASE_BOTTOM = 0.3;

/**
 * Alpha of a wash layer at translucency `t`. Scaling the wash with `t` is what
 * lets the desktop through: a wash held near-constant keeps the pane ~86%
 * opaque even at the glass end.
 */
export function washAlpha(base: number, translucency: number): number {
  return base * clampTranslucency(translucency);
}

/**
 * Opacity for the photo under a wash of `washAlpha`, such that the two
 * together cover exactly `t`. Solves `wash + photo * (1 - wash) = t`.
 */
export function photoOpacity(translucency: number, wash: number): number {
  const t = clampTranslucency(translucency);
  if (wash >= 1) {
    return 0;
  }
  return Math.min(Math.max((t - wash) / (1 - wash), 0), 1);
}

/**
 * What a photo + wash pair actually covers — `t` by construction, and the
 * number a composite probe checks against.
 */
export function coverage(photo: number, wash: number): number {
  return wash + photo * (1 - wash);
}

/**
 * Alpha of the flat window plate over the system backdrop: `0` through the
 * glass band, ramping to `1` (fully solid window) at `1.0`.
 */
export function windowPlate(translucency: number): number {
  const t = clampTranslucency(translucency);
  const upper = TRANSLUCENCY_RANGE.upperBound;
  if (t <= PLATE_START) {
    return 0;
  }
  return Math.min((t - PLATE_START) / (upper - PLATE_START), 1);
}

/**
 * The DWM system backdrop that best matches a translucency setting. At the
 * fully solid end there is nothing to composite behind the window, so asking
 * DWM for a material is wasted work (and shows through the rounded corners).
 */
export function backdropForTranslucency(
  translucency: number,
  preferred: "mica" | "mica-alt" | "acrylic",
): "none" | "mica" | "mica-alt" | "acrylic" {
  return clampTranslucency(translucency) >= TRANSLUCENCY_RANGE.upperBound ? "none" : preferred;
}

/** The complete layer stack for a translucency, ready to hand to CSS. */
export interface LayerStack {
  readonly plateAlpha: number;
  readonly washAlpha: number;
  readonly photoOpacity: number;
  /** Always equals the clamped translucency below `PLATE_START`. */
  readonly coverage: number;
}

export function layerStack(translucency: number, colorScheme: "light" | "dark"): LayerStack {
  const wash = washAlpha(chatWashBase(colorScheme), translucency);
  const photo = photoOpacity(translucency, wash);
  return {
    plateAlpha: windowPlate(translucency),
    washAlpha: wash,
    photoOpacity: photo,
    coverage: coverage(photo, wash),
  };
}
