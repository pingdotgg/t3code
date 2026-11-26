// Fork: names for Kaluwa's presets, swatches and look options.
import { msg } from "gt-react";

import type { KaluwaPresetId, KaluwaSwatchSlot } from "../../kaluwa/kaluwaPalette";

export const KALUWA_SWATCH_LABELS: Readonly<Record<KaluwaSwatchSlot, string>> = {
  accent: msg("Accent", { $context: "palette swatch name" }),
  clay: msg("Clay", { $context: "palette swatch name" }),
  ochre: msg("Ochre", { $context: "palette swatch name" }),
  sand: msg("Sand", { $context: "palette swatch name" }),
  moss: msg("Moss", { $context: "palette swatch name" }),
  sage: msg("Sage", { $context: "palette swatch name" }),
  lagoon: msg("Lagoon", { $context: "palette swatch name" }),
  steel: msg("Steel", { $context: "palette swatch name" }),
  slate: msg("Slate", { $context: "palette swatch name" }),
  dusk: msg("Dusk", { $context: "palette swatch name" }),
  plum: msg("Plum", { $context: "palette swatch name" }),
  rose: msg("Rose", { $context: "palette swatch name" }),
  ash: msg("Ash", { $context: "palette swatch name" }),
  bone: msg("Bone", { $context: "palette swatch name" }),
};

export const KALUWA_PRESET_LABELS: Readonly<
  Record<KaluwaPresetId, Readonly<{ name: string; blurb: string }>>
> = {
  today: {
    name: msg("Kaluwa today", { $context: "theme preset name" }),
    blurb: msg("True black, blue wave band"),
  },
  ember: {
    name: msg("Ember", { $context: "theme preset name" }),
    blurb: msg("Warm charcoal, ember accent"),
  },
  tide: {
    name: msg("Graphite Tide", { $context: "theme preset name" }),
    blurb: msg("Cool graphite, Kaluwa blue"),
  },
  noir: {
    name: msg("Noir Rider", { $context: "theme preset name" }),
    blurb: msg("Today's black, softer edges"),
  },
  paper: {
    name: msg("Paper", { $context: "theme preset name" }),
    blurb: msg("Light, warm stone, ink orange"),
  },
};

export const KALUWA_MOOD_LABELS = {
  luminous: msg("Luminous", { $context: "palette mood" }),
  jewel: msg("Jewel", { $context: "palette mood" }),
  muted: msg("Muted", { $context: "palette mood" }),
} as const;

export const KALUWA_EMPHASIS_LABELS = {
  soft: msg("Soft", { $context: "status label emphasis" }),
  quiet: msg("Quiet", { $context: "status label emphasis" }),
  all: msg("All", { $context: "status label emphasis" }),
  off: msg("Off", { $context: "status label emphasis" }),
} as const;

export const KALUWA_STATUS_COLOR_LABELS = {
  palette: msg("Palette", { $context: "status colors from the theme palette" }),
  classic: msg("Classic", { $context: "status colors, the original bright set" }),
} as const;

export const KALUWA_BADGE_LABELS = {
  tinted: msg("Tinted", { $context: "badge style" }),
  outline: msg("Outline", { $context: "badge style" }),
  mono: msg("Monochrome", { $context: "badge style" }),
} as const;

export const KALUWA_TILE_LABELS = {
  tinted: msg("Tinted gradient", { $context: "project tile style" }),
  mono: msg("Monochrome", { $context: "project tile style" }),
} as const;

export const KALUWA_LOGO_LABELS = {
  soft: msg("Softened", { $context: "provider logo style" }),
  original: msg("Original", { $context: "provider logo style" }),
  mono: msg("Monochrome", { $context: "provider logo style" }),
} as const;
