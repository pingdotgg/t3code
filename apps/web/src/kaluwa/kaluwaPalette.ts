// Fork: Kaluwa's theme presets and their curated 14-swatch palettes. Ported from the theme lab
// the owner approved, so the numbers here are tuned values, not derived ones. Pure: no DOM, no app
// state, so palettes, presets and swatch lookups can be tested on their own.
import type { ThemeAppearance, ThemeColorRole } from "@t3tools/shared/themePalettes";

export const KALUWA_SWATCH_SLOTS = [
  "accent",
  "clay",
  "ochre",
  "sand",
  "moss",
  "sage",
  "lagoon",
  "steel",
  "slate",
  "dusk",
  "plum",
  "rose",
  "ash",
  "bone",
] as const;
export type KaluwaSwatchSlot = (typeof KALUWA_SWATCH_SLOTS)[number];
export type KaluwaPalette = Readonly<Record<KaluwaSwatchSlot, string>>;

export const KALUWA_PALETTE_MOODS = ["luminous", "jewel", "muted"] as const;
export type KaluwaPaletteMood = (typeof KALUWA_PALETTE_MOODS)[number];

export const KALUWA_PRESET_IDS = ["today", "ember", "tide", "noir", "paper"] as const;
export type KaluwaPresetId = (typeof KALUWA_PRESET_IDS)[number];

// Slot base hue and chroma. "accent" takes the preset's accent hue; "ash" and "bone" are tinted
// neutrals on the preset's neutral hue.
const SLOT_HUE_CHROMA: Readonly<Record<KaluwaSwatchSlot, readonly [hue: number, chroma: number]>> =
  {
    accent: [0, 0.1],
    clay: [32, 0.08],
    ochre: [78, 0.078],
    sand: [92, 0.04],
    moss: [128, 0.068],
    sage: [155, 0.055],
    lagoon: [200, 0.06],
    steel: [240, 0.064],
    slate: [265, 0.034],
    dusk: [295, 0.068],
    plum: [330, 0.068],
    rose: [8, 0.072],
    ash: [0, 0.012],
    bone: [0, 0.01],
  };

type PaletteConfig = Readonly<{
  accentHue: number;
  neutralHue: number;
  chroma: number;
  /** Swatch lightness for [dark, light]. */
  lightness: readonly [number, number];
}>;

const PALETTE_CONFIG: Readonly<Record<KaluwaPresetId, PaletteConfig>> = {
  today: { accentHue: 264, neutralHue: 260, chroma: 1.12, lightness: [0.745, 0.5] },
  ember: { accentHue: 42, neutralHue: 70, chroma: 1, lightness: [0.735, 0.49] },
  tide: { accentHue: 262, neutralHue: 258, chroma: 0.96, lightness: [0.74, 0.49] },
  noir: { accentHue: 262, neutralHue: 262, chroma: 1.04, lightness: [0.74, 0.5] },
  paper: { accentHue: 40, neutralHue: 75, chroma: 1, lightness: [0.735, 0.485] },
};

// Moods reshape the same slots. Muted is one flat lightness; Luminous and Jewel vary lightness and
// chroma per hue, so yellows and greens sit lighter and blues and violets a touch deeper.
type MoodConfig = Readonly<{
  lightnessShift: readonly [number, number];
  chromaScale: readonly [number, number];
  soft: number;
  vary: number;
}>;
const MOOD_CONFIG: Readonly<Record<KaluwaPaletteMood, MoodConfig>> = {
  muted: { lightnessShift: [0, 0], chromaScale: [1, 1], soft: 1, vary: 0 },
  luminous: { lightnessShift: [0.055, -0.005], chromaScale: [1.5, 1.45], soft: 1.25, vary: 1 },
  jewel: { lightnessShift: [-0.04, -0.035], chromaScale: [1.72, 1.8], soft: 1.3, vary: 1.25 },
};

// Per-slot lightness nudge and chroma weight for the dark scheme; light reverses and halves the nudge.
const SLOT_TUNING: Readonly<
  Record<KaluwaSwatchSlot, readonly [lightness: number, chroma: number]>
> = {
  accent: [0, 1.1],
  clay: [-0.012, 1.05],
  ochre: [0.04, 0.95],
  sand: [0.03, 1],
  moss: [0.035, 0.95],
  sage: [0.025, 1],
  lagoon: [0.015, 1],
  steel: [-0.01, 1.08],
  slate: [-0.005, 1],
  dusk: [-0.025, 1.15],
  plum: [-0.02, 1.08],
  rose: [-0.01, 1.02],
  ash: [0, 1],
  bone: [0, 1],
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function hexChannel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

/** OKLCH to sRGB hex, clamping each linear channel the way the lab did. */
export function oklchToHex(lightness: number, chroma: number, hue: number): string {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((channel) => {
      const v = clamp01(channel);
      return hexChannel(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    })
    .join("")}`;
}

const paletteCache = new Map<string, KaluwaPalette>();

export function kaluwaPalette(
  preset: KaluwaPresetId,
  scheme: ThemeAppearance,
  mood: KaluwaPaletteMood,
): KaluwaPalette {
  const key = `${preset}:${scheme}:${mood}`;
  const cached = paletteCache.get(key);
  if (cached) return cached;
  const config = PALETTE_CONFIG[preset];
  const moodConfig = MOOD_CONFIG[mood];
  const dark = scheme === "dark";
  const index = dark ? 0 : 1;
  const baseLightness = config.lightness[index] + moodConfig.lightnessShift[index];
  const neutralChroma = mood === "muted" ? 1 : 1.4;
  const palette = {} as Record<KaluwaSwatchSlot, string>;
  for (const slot of KALUWA_SWATCH_SLOTS) {
    const [hue, chroma] = SLOT_HUE_CHROMA[slot];
    const [lightnessTune, chromaTune] = SLOT_TUNING[slot];
    if (slot === "ash" || slot === "bone") {
      const shift = slot === "ash" ? (dark ? -0.06 : 0.02) : dark ? 0.1 : -0.1;
      palette[slot] = oklchToHex(
        config.lightness[index] + shift,
        chroma * neutralChroma,
        config.neutralHue,
      );
      continue;
    }
    const lightness =
      baseLightness + moodConfig.vary * (dark ? lightnessTune : -lightnessTune * 0.5);
    const soft = slot === "sand" || slot === "slate";
    const scale = soft
      ? moodConfig.soft
      : moodConfig.chromaScale[index] * (moodConfig.vary ? chromaTune : 1);
    palette[slot] = oklchToHex(
      lightness,
      chroma * config.chroma * scale,
      slot === "accent" ? config.accentHue : hue,
    );
  }
  paletteCache.set(key, palette);
  return palette;
}

export type KaluwaStatus = "working" | "waiting" | "approval" | "input" | "failed" | "done";

/** The lab's default status set: each status points at a swatch, so it follows the palette. */
export const KALUWA_STATUS_SWATCHES: Readonly<Record<KaluwaStatus, KaluwaSwatchSlot>> = {
  working: "steel",
  waiting: "ash",
  approval: "ochre",
  input: "dusk",
  failed: "clay",
  done: "sage",
};

/** Project icon colours are a fixed contract enum; on Kaluwa each paints as its nearest swatch. */
export const KALUWA_PROJECT_COLOR_SWATCHES: Readonly<Record<string, KaluwaSwatchSlot>> = {
  gray: "ash",
  red: "clay",
  orange: "accent",
  amber: "ochre",
  yellow: "sand",
  lime: "moss",
  green: "moss",
  emerald: "sage",
  teal: "lagoon",
  cyan: "lagoon",
  sky: "steel",
  blue: "steel",
  indigo: "slate",
  violet: "dusk",
  purple: "dusk",
  fuchsia: "plum",
  pink: "rose",
  rose: "rose",
};

let swatchIndex: ReadonlyMap<string, KaluwaSwatchSlot> | null = null;

/**
 * The slot a stored accent hex was picked from, in any preset, scheme or mood. Accent colours are
 * stored as plain hex (the contract and mobile need one), and a known swatch hex is shown as that
 * slot of the current palette, so it follows preset and mood changes.
 */
export function kaluwaSwatchSlotForHex(hex: string): KaluwaSwatchSlot | null {
  if (swatchIndex === null) {
    const index = new Map<string, KaluwaSwatchSlot>();
    for (const preset of KALUWA_PRESET_IDS) {
      for (const scheme of ["dark", "light"] as const) {
        for (const mood of KALUWA_PALETTE_MOODS) {
          const palette = kaluwaPalette(preset, scheme, mood);
          for (const slot of KALUWA_SWATCH_SLOTS) {
            if (!index.has(palette[slot])) index.set(palette[slot], slot);
          }
        }
      }
    }
    swatchIndex = index;
  }
  return swatchIndex.get(hex.trim().toLowerCase()) ?? null;
}

export type KaluwaSchemeColors = Readonly<{
  bg: string;
  chrome: string;
  sidebar: string;
  card: string;
  composer: string;
  fg: string;
  muted: string;
  accent: string;
  accentFg: string;
  /** Border opacity, in percent of the scheme's ink. */
  borderAlpha: number;
}>;

export type KaluwaPreset = Readonly<{
  id: KaluwaPresetId;
  /** The app theme id, or null for "Kaluwa today", which is the stock theme. */
  themeId: string | null;
  scheme: ThemeAppearance;
  /** Corner radii in px: panels drive `--radius`, controls `--control-radius`. */
  radius: number;
  controlRadius: number;
  /** Only Inter is bundled; other lab fonts fall back to the system stack. */
  font: "system" | "inter";
  dark: KaluwaSchemeColors;
  light: KaluwaSchemeColors;
  /** Theme studio shape extras, in px and percent; built-in presets leave them to the app. */
  composerRadius?: number;
  shadow?: number;
}>;

export const KALUWA_PRESETS: Readonly<Record<KaluwaPresetId, KaluwaPreset>> = {
  today: {
    id: "today",
    themeId: null,
    scheme: "dark",
    radius: 8,
    controlRadius: 8,
    font: "system",
    dark: {
      bg: "#000000",
      chrome: "#000000",
      sidebar: "#000000",
      card: "#111111",
      composer: "#111111",
      fg: "#f1f3f7",
      muted: "#a3a3a3",
      accent: "#3f72f5",
      accentFg: "#ffffff",
      borderAlpha: 8,
    },
    light: {
      bg: "#fcfcfc",
      chrome: "#fcfcfc",
      sidebar: "#fafafa",
      card: "#ffffff",
      composer: "#ffffff",
      fg: "#18181b",
      muted: "#71717a",
      accent: "#2553e6",
      accentFg: "#ffffff",
      borderAlpha: 11,
    },
  },
  ember: {
    id: "ember",
    themeId: "kaluwa-ember",
    scheme: "dark",
    radius: 12,
    controlRadius: 8,
    font: "inter",
    dark: {
      bg: "#1d1c1b",
      chrome: "#1d1c1b",
      sidebar: "#1d1c1b",
      card: "#242322",
      composer: "#161514",
      fg: "#f5f4f2",
      muted: "#aaa8a3",
      accent: "#f2683a",
      accentFg: "#1c0b04",
      borderAlpha: 9,
    },
    light: {
      bg: "#f5f4f2",
      chrome: "#f5f4f2",
      sidebar: "#f5f4f2",
      card: "#fbfaf8",
      composer: "#fbfaf8",
      fg: "#141413",
      muted: "#66635e",
      accent: "#c8481a",
      accentFg: "#ffffff",
      borderAlpha: 10,
    },
  },
  tide: {
    id: "tide",
    themeId: "kaluwa-tide",
    scheme: "dark",
    radius: 14,
    controlRadius: 9,
    font: "system",
    dark: {
      bg: "#17181c",
      chrome: "#0f1013",
      sidebar: "#131418",
      card: "#1e2025",
      composer: "#101115",
      fg: "#eef0f6",
      muted: "#9a9fad",
      accent: "#5b8cff",
      accentFg: "#050d24",
      borderAlpha: 9,
    },
    light: {
      bg: "#f6f7f9",
      chrome: "#e9ebf0",
      sidebar: "#f0f1f5",
      card: "#ffffff",
      composer: "#ffffff",
      fg: "#14161c",
      muted: "#5d6372",
      accent: "#1f55e0",
      accentFg: "#ffffff",
      borderAlpha: 11,
    },
  },
  noir: {
    id: "noir",
    themeId: "kaluwa-noir",
    scheme: "dark",
    radius: 10,
    controlRadius: 8,
    font: "system",
    dark: {
      bg: "#000000",
      chrome: "#000000",
      sidebar: "#050506",
      card: "#0e0e10",
      composer: "#0c0c0e",
      fg: "#f1f3f7",
      muted: "#a0a3ad",
      accent: "#5b8cff",
      accentFg: "#04102e",
      borderAlpha: 9,
    },
    light: {
      bg: "#ffffff",
      chrome: "#ffffff",
      sidebar: "#f7f8fb",
      card: "#ffffff",
      composer: "#ffffff",
      fg: "#101219",
      muted: "#666b78",
      accent: "#1650d8",
      accentFg: "#ffffff",
      borderAlpha: 10,
    },
  },
  paper: {
    id: "paper",
    themeId: "kaluwa-paper",
    scheme: "light",
    radius: 12,
    controlRadius: 8,
    font: "inter",
    light: {
      bg: "#f7f6f3",
      chrome: "#eceae5",
      sidebar: "#f1efeb",
      card: "#fdfcfa",
      composer: "#fdfcfa",
      fg: "#161513",
      muted: "#67635c",
      accent: "#b8451b",
      accentFg: "#ffffff",
      borderAlpha: 11,
    },
    dark: {
      bg: "#191817",
      chrome: "#121110",
      sidebar: "#151413",
      card: "#201f1d",
      composer: "#131211",
      fg: "#f5f4f2",
      muted: "#a5a29b",
      accent: "#ff8a5c",
      accentFg: "#220d03",
      borderAlpha: 9,
    },
  },
};

export const KALUWA_DEFAULT_THEME_ID = "kaluwa-ember";

/** The preset whose palette a theme uses: a Kaluwa theme's own, otherwise "Kaluwa today". */
export function kaluwaPresetForThemeId(themeId: string | null | undefined): KaluwaPreset {
  for (const id of KALUWA_PRESET_IDS) {
    const preset = KALUWA_PRESETS[id];
    if (preset.themeId !== null && preset.themeId === themeId) return preset;
  }
  return KALUWA_PRESETS.today;
}

function parseHex(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function mixHex(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  return `#${a.map((channel, index) => hexChannel(channel + (b[index]! - channel) * amount)).join("")}`;
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgb(${r} ${g} ${b} / ${Number((alpha * 100).toFixed(1))}%)`;
}

/**
 * A preset's colours as app theme roles, mapped the way the lab's export did. Roles left out
 * (toolbar controls, status, search and terminal) come from the generated base palette. Lift is
 * a setting, so it is applied in CSS on top of these rather than baked in.
 */
export function kaluwaThemeRoleColors(
  preset: KaluwaPreset,
  scheme: ThemeAppearance,
): Readonly<Partial<Record<ThemeColorRole, string>>> {
  const colors = preset[scheme];
  const dark = scheme === "dark";
  const ink = dark ? "#ffffff" : "#000000";
  const border = withAlpha(ink, colors.borderAlpha / 100);
  const borderStrong = withAlpha(ink, Math.min(0.7, (colors.borderAlpha / 100) * 1.45));
  const rowHover = withAlpha(ink, dark ? 0.06 : 0.045);
  const rowSelected = withAlpha(ink, dark ? 0.1 : 0.075);
  const control = withAlpha(ink, dark ? 0.05 : 0.04);
  const message = mixHex(colors.bg, colors.fg, dark ? 0.09 : 0.075);
  const code = mixHex(colors.card, dark ? "#000000" : colors.bg, dark ? 0.35 : 0.5);
  return {
    canvas: colors.bg,
    chrome: colors.chrome,
    toolbar: colors.chrome,
    toolbarForeground: colors.fg,
    toolbarBorder: border,
    surface: colors.card,
    surfaceRaised: colors.composer,
    surfaceOverlay: colors.card,
    text: colors.fg,
    textMuted: colors.muted,
    border,
    input: borderStrong,
    focus: colors.accent,
    accent: colors.accent,
    accentForeground: colors.accentFg,
    secondary: control,
    secondaryForeground: colors.fg,
    muted: control,
    mutedForeground: colors.muted,
    placeholder: colors.muted,
    secondaryLabel: colors.muted,
    iconMuted: colors.muted,
    accentSurface: rowHover,
    accentSurfaceForeground: colors.fg,
    messageSurface: message,
    messageForeground: colors.fg,
    messageAction: colors.accent,
    messageActionForeground: colors.accentFg,
    messageActionHover: mixHex(colors.accent, dark ? "#ffffff" : "#000000", 0.1),
    codeBackground: code,
    codeForeground: colors.fg,
    sidebar: colors.sidebar,
    sidebarForeground: colors.fg,
    sidebarMutedForeground: colors.muted,
    sidebarControlSurface: control,
    sidebarRowHover: rowHover,
    sidebarRowActive: rowSelected,
    sidebarRowSelected: rowSelected,
    sidebarBorder: border,
    terminalBackground: colors.bg,
    terminalForeground: colors.fg,
    terminalCursor: colors.accent,
  };
}

/** The swatch and status custom properties for one palette, as `--kaluwa-swatch-*` pairs. */
export function kaluwaPaletteVariables(palette: KaluwaPalette): ReadonlyArray<[string, string]> {
  return KALUWA_SWATCH_SLOTS.map((slot) => [`--kaluwa-swatch-${slot}`, palette[slot]]);
}
