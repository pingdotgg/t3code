import {
  THEME_TOKEN_NAMES,
  type ThemePaletteDefinition,
  type ThemeTokenName,
} from "@t3tools/contracts";

export type ResolvedThemeMode = "light" | "dark";
export type ThemePreference = ResolvedThemeMode | "system";
export type ThemeTokenMap = Record<ThemeTokenName, string>;
export type ThemeTokenOverrides = Partial<ThemeTokenMap>;

export interface ThemePalette {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly source: "built-in" | "custom";
  readonly light: ThemeTokenMap;
  readonly dark: ThemeTokenMap;
}

interface ThemePaletteInput {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly light?: ThemeTokenOverrides;
  readonly dark?: ThemeTokenOverrides;
}

export const DEFAULT_THEME_PALETTE_ID = "default";

const DEFAULT_LIGHT_TOKENS: ThemeTokenMap = {
  background: "var(--color-white)",
  foreground: "var(--color-neutral-800)",
  card: "var(--color-white)",
  "card-foreground": "var(--color-neutral-800)",
  popover: "var(--color-white)",
  "popover-foreground": "var(--color-neutral-800)",
  primary: "oklch(0.488 0.217 264)",
  "primary-foreground": "var(--color-white)",
  secondary: "color-mix(in srgb, var(--color-black) 4%, transparent)",
  "secondary-foreground": "var(--color-neutral-800)",
  muted: "color-mix(in srgb, var(--color-black) 4%, transparent)",
  "muted-foreground": "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-black))",
  accent: "color-mix(in srgb, var(--color-black) 4%, transparent)",
  "accent-foreground": "var(--color-neutral-800)",
  destructive: "var(--color-red-500)",
  "destructive-foreground": "var(--color-red-700)",
  border: "color-mix(in srgb, var(--color-black) 8%, transparent)",
  input: "color-mix(in srgb, var(--color-black) 10%, transparent)",
  ring: "oklch(0.488 0.217 264)",
  info: "var(--color-blue-500)",
  "info-foreground": "var(--color-blue-700)",
  success: "var(--color-emerald-500)",
  "success-foreground": "var(--color-emerald-700)",
  warning: "var(--color-amber-500)",
  "warning-foreground": "var(--color-amber-700)",
};

const DEFAULT_DARK_TOKENS: ThemeTokenMap = {
  background: "color-mix(in srgb, var(--color-neutral-950) 95%, var(--color-white))",
  foreground: "var(--color-neutral-100)",
  card: "color-mix(in srgb, var(--background) 98%, var(--color-white))",
  "card-foreground": "var(--color-neutral-100)",
  popover: "color-mix(in srgb, var(--background) 98%, var(--color-white))",
  "popover-foreground": "var(--color-neutral-100)",
  primary: "oklch(0.588 0.217 264)",
  "primary-foreground": "var(--color-white)",
  secondary: "color-mix(in srgb, var(--color-white) 4%, transparent)",
  "secondary-foreground": "var(--color-neutral-100)",
  muted: "color-mix(in srgb, var(--color-white) 4%, transparent)",
  "muted-foreground": "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-white))",
  accent: "color-mix(in srgb, var(--color-white) 4%, transparent)",
  "accent-foreground": "var(--color-neutral-100)",
  destructive: "color-mix(in srgb, var(--color-red-500) 90%, var(--color-white))",
  "destructive-foreground": "var(--color-red-400)",
  border: "color-mix(in srgb, var(--color-white) 6%, transparent)",
  input: "color-mix(in srgb, var(--color-white) 8%, transparent)",
  ring: "oklch(0.588 0.217 264)",
  info: "var(--color-blue-500)",
  "info-foreground": "var(--color-blue-400)",
  success: "var(--color-emerald-500)",
  "success-foreground": "var(--color-emerald-400)",
  warning: "var(--color-amber-500)",
  "warning-foreground": "var(--color-amber-400)",
};

const BUILT_IN_THEME_PALETTES: readonly ThemePaletteInput[] = [
  {
    id: DEFAULT_THEME_PALETTE_ID,
    label: "Default",
    description: "Neutral surfaces with violet accents.",
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Cool blue surfaces with cyan highlights.",
    light: {
      background: "oklch(0.985 0.01 240)",
      card: "oklch(0.995 0.004 240)",
      popover: "oklch(0.995 0.004 240)",
      primary: "oklch(0.55 0.18 240)",
      ring: "oklch(0.55 0.18 240)",
      accent: "oklch(0.93 0.02 235)",
      info: "oklch(0.62 0.16 230)",
      "info-foreground": "oklch(0.42 0.08 230)",
      border: "color-mix(in srgb, oklch(0.55 0.18 240) 10%, transparent)",
      input: "color-mix(in srgb, oklch(0.55 0.18 240) 12%, transparent)",
    },
    dark: {
      background: "oklch(0.18 0.03 245)",
      card: "oklch(0.22 0.03 245)",
      popover: "oklch(0.22 0.03 245)",
      primary: "oklch(0.74 0.16 225)",
      ring: "oklch(0.74 0.16 225)",
      accent: "color-mix(in srgb, oklch(0.74 0.16 225) 12%, transparent)",
      info: "oklch(0.78 0.12 220)",
      border: "color-mix(in srgb, oklch(0.74 0.16 225) 16%, transparent)",
      input: "color-mix(in srgb, oklch(0.74 0.16 225) 18%, transparent)",
    },
  },
  {
    id: "forest",
    label: "Forest",
    description: "Mossy greens with softer neutrals.",
    light: {
      background: "oklch(0.985 0.01 150)",
      card: "oklch(0.995 0.004 150)",
      popover: "oklch(0.995 0.004 150)",
      primary: "oklch(0.56 0.16 155)",
      ring: "oklch(0.56 0.16 155)",
      success: "oklch(0.62 0.17 155)",
      "success-foreground": "oklch(0.4 0.08 155)",
      accent: "oklch(0.94 0.02 155)",
      border: "color-mix(in srgb, oklch(0.56 0.16 155) 10%, transparent)",
      input: "color-mix(in srgb, oklch(0.56 0.16 155) 12%, transparent)",
    },
    dark: {
      background: "oklch(0.19 0.02 155)",
      card: "oklch(0.22 0.02 155)",
      popover: "oklch(0.22 0.02 155)",
      primary: "oklch(0.76 0.16 155)",
      ring: "oklch(0.76 0.16 155)",
      success: "oklch(0.78 0.15 155)",
      accent: "color-mix(in srgb, oklch(0.76 0.16 155) 12%, transparent)",
      border: "color-mix(in srgb, oklch(0.76 0.16 155) 16%, transparent)",
      input: "color-mix(in srgb, oklch(0.76 0.16 155) 18%, transparent)",
    },
  },
  {
    id: "sunset",
    label: "Sunset",
    description: "Warm amber accents with soft rose highlights.",
    light: {
      background: "oklch(0.988 0.008 40)",
      card: "oklch(0.998 0.004 30)",
      popover: "oklch(0.998 0.004 30)",
      primary: "oklch(0.66 0.17 40)",
      ring: "oklch(0.66 0.17 40)",
      warning: "oklch(0.74 0.16 70)",
      "warning-foreground": "oklch(0.47 0.12 70)",
      accent: "oklch(0.95 0.02 20)",
      border: "color-mix(in srgb, oklch(0.66 0.17 40) 10%, transparent)",
      input: "color-mix(in srgb, oklch(0.66 0.17 40) 12%, transparent)",
    },
    dark: {
      background: "oklch(0.2 0.02 28)",
      card: "oklch(0.24 0.02 28)",
      popover: "oklch(0.24 0.02 28)",
      primary: "oklch(0.76 0.16 55)",
      ring: "oklch(0.76 0.16 55)",
      warning: "oklch(0.79 0.15 75)",
      accent: "color-mix(in srgb, oklch(0.76 0.16 55) 12%, transparent)",
      border: "color-mix(in srgb, oklch(0.76 0.16 55) 16%, transparent)",
      input: "color-mix(in srgb, oklch(0.76 0.16 55) 18%, transparent)",
    },
  },
] as const;

export const CUSTOM_THEME_FILE_EXAMPLE = `[
  {
    "id": "midnight-mint",
    "label": "Midnight Mint",
    "description": "Custom palette loaded from ~/.t3/themes.json",
    "dark": {
      "background": "oklch(0.17 0.02 220)",
      "card": "oklch(0.21 0.02 220)",
      "primary": "oklch(0.79 0.16 170)",
      "ring": "oklch(0.79 0.16 170)"
    }
  }
]`;

function resolveThemePalette(
  input: ThemePaletteInput | ThemePaletteDefinition,
  source: ThemePalette["source"],
) {
  const description =
    "description" in input && typeof input.description === "string"
      ? input.description
      : source === "custom"
        ? "Loaded from your ~/.t3 themes file."
        : "Built into T3 Code.";

  return {
    id: input.id,
    label: input.label,
    description,
    source,
    light: { ...DEFAULT_LIGHT_TOKENS, ...sanitizeThemeTokenOverrides(input.light) },
    dark: { ...DEFAULT_DARK_TOKENS, ...sanitizeThemeTokenOverrides(input.dark) },
  } satisfies ThemePalette;
}

function sanitizeThemeTokenOverrides(overrides: Record<string, string> | undefined) {
  const sanitized: ThemeTokenOverrides = {};
  if (!overrides) {
    return sanitized;
  }

  for (const tokenName of THEME_TOKEN_NAMES) {
    const value = overrides[tokenName];
    if (typeof value === "string") {
      sanitized[tokenName] = value;
    }
  }

  return sanitized;
}

const BUILT_IN_THEME_PALETTE_MAP = new Map(
  BUILT_IN_THEME_PALETTES.map((palette) => [palette.id, resolveThemePalette(palette, "built-in")]),
);

export function getBuiltInThemePalettes() {
  return [...BUILT_IN_THEME_PALETTE_MAP.values()];
}

export function getThemePaletteCatalog(customThemes: readonly ThemePaletteDefinition[] = []) {
  return [
    ...getBuiltInThemePalettes(),
    ...customThemes.map((palette) => resolveThemePalette(palette, "custom")),
  ];
}
