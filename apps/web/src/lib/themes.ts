/**
 * Theme definitions, CSS injection, and accent color derivation.
 *
 * V1 themes override a focused set of CSS custom properties.
 * Background/surface tokens stay controlled by the CSS baseline in index.css.
 *
 * The override targets are the intermediate variables (--primary, --border, etc.)
 * which feed into Tailwind's --color-* via @theme inline { --color-primary: var(--primary) }.
 */

// ── Token types ──────────────────────────────────────────────────

/**
 * The set of CSS custom-property names a theme may override.
 * Uses the unprefixed form (e.g. "primary", not "--color-primary").
 */
export type ThemeToken =
  | "primary"
  | "primary-foreground"
  | "ring"
  | "destructive"
  | "destructive-foreground"
  | "info"
  | "info-foreground"
  | "success"
  | "success-foreground"
  | "warning"
  | "warning-foreground"
  | "muted-foreground"
  | "border"
  | "input"
  | "diff-addition"
  | "diff-deletion";

export type ThemeTokenMap = Partial<Record<ThemeToken, string>>;

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  light: ThemeTokenMap;
  dark: ThemeTokenMap;
}

// ── Built-in themes ──────────────────────────────────────────────

const T3CODE_THEME: ThemeDefinition = {
  id: "t3code",
  name: "T3Code",
  description: "Default color palette.",
  builtIn: true,
  light: {},
  dark: {},
};

/**
 * High Contrast — strengthens borders, inputs, and muted text for readability.
 * Ported from PR #1284 which overrides --muted-foreground, --border, --input.
 */
const HIGH_CONTRAST_THEME: ThemeDefinition = {
  id: "high-contrast",
  name: "High Contrast",
  description: "Stronger borders and text for readability.",
  builtIn: true,
  light: {
    "muted-foreground": "color-mix(in srgb, var(--color-neutral-700) 92%, var(--color-black))",
    border: "--alpha(var(--color-black) / 45%)",
    input: "--alpha(var(--color-black) / 50%)",
  },
  dark: {
    "muted-foreground": "color-mix(in srgb, var(--color-neutral-300) 92%, var(--color-white))",
    border: "--alpha(var(--color-white) / 40%)",
    input: "--alpha(var(--color-white) / 45%)",
  },
};

/**
 * Color Blind — replaces red/green juxtaposition in diffs with blue/orange.
 * Ported from PR #1535 which uses GitHub Primer @primer/primitives diffBlob palette.
 *
 * Only overrides --diff-addition / --diff-deletion (the diff-specific tokens).
 * Success (green) and destructive (red) are fine in isolation — the problem
 * is only when they appear side-by-side in diffs.
 */
const COLOR_BLIND_THEME: ThemeDefinition = {
  id: "color-blind",
  name: "Color Blind",
  description: "Blue/orange diffs for color vision deficiency.",
  builtIn: true,
  light: {
    "diff-addition": "#0969da", // blue (replaces green)
    "diff-deletion": "#bc4c00", // orange (replaces red)
  },
  dark: {
    "diff-addition": "#388bfd", // blue (replaces green)
    "diff-deletion": "#db6d28", // orange (replaces red)
  },
};

export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  T3CODE_THEME,
  HIGH_CONTRAST_THEME,
  COLOR_BLIND_THEME,
];

export const DEFAULT_THEME_ID = "t3code";

// ── Accent presets ───────────────────────────────────────────────

export interface AccentPreset {
  name: string;
  hue: number;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { name: "Red", hue: 25 },
  { name: "Orange", hue: 55 },
  { name: "Yellow", hue: 85 },
  { name: "Green", hue: 145 },
  { name: "Teal", hue: 185 },
  { name: "Blue", hue: 240 },
  { name: "Purple", hue: 290 },
  { name: "Pink", hue: 340 },
];

// ── Lookup ───────────────────────────────────────────────────────

export function findThemeById(id: string): ThemeDefinition | undefined {
  return BUILT_IN_THEMES.find((t) => t.id === id);
}

// ── Accent derivation (oklch) ────────────────────────────────────

export function deriveAccentColors(hue: number): { light: ThemeTokenMap; dark: ThemeTokenMap } {
  return {
    light: {
      primary: `oklch(0.488 0.217 ${hue})`,
      "primary-foreground": "oklch(1 0 0)",
      ring: `oklch(0.488 0.217 ${hue})`,
    },
    dark: {
      primary: `oklch(0.588 0.217 ${hue})`,
      "primary-foreground": "oklch(1 0 0)",
      ring: `oklch(0.588 0.217 ${hue})`,
    },
  };
}

// ── CSS injection via inline styles ──────────────────────────────
//
// We set CSS custom properties directly on document.documentElement.style
// (inline styles). This is the highest specificity in the cascade and
// guarantees our overrides beat any stylesheet — including Vite HMR
// injections that can reorder <style> elements unpredictably.

/** Track which properties were set so we can clean them up. */
let appliedProperties: string[] = [];

/**
 * Apply theme token overrides as inline CSS custom properties on <html>.
 * Resolves light/dark tokens based on `resolvedTheme` and sets them directly.
 * When the T3Code default is active with no accent, removes all overrides.
 */
export function applyThemeTokens(
  theme: ThemeDefinition,
  accentHue: number | null,
  resolvedTheme: "light" | "dark",
): void {
  const accent = accentHue != null ? deriveAccentColors(accentHue) : null;

  const tokens: ThemeTokenMap =
    resolvedTheme === "dark"
      ? { ...theme.dark, ...accent?.dark }
      : { ...theme.light, ...accent?.light };

  // Clean up previously applied properties
  removeThemeTokens();

  const entries = Object.entries(tokens) as [ThemeToken, string][];
  if (entries.length === 0) return;

  const el = document.documentElement;
  const props: string[] = [];
  for (const [token, value] of entries) {
    const prop = `--${token}`;
    el.style.setProperty(prop, value);
    props.push(prop);
  }
  appliedProperties = props;
}

export function removeThemeTokens(): void {
  const el = document.documentElement;
  for (const prop of appliedProperties) {
    el.style.removeProperty(prop);
  }
  appliedProperties = [];
}
