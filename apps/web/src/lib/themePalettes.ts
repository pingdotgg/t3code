import * as Schema from "effect/Schema";

/**
 * Selectable color palettes. A palette is orthogonal to the light/dark mode in
 * `useTheme`: mode picks the brightness, the palette picks the surface and
 * accent family, and the two combine in `index.css`.
 *
 * `default` is special. Its tokens are the literal `:root` declarations in
 * `index.css`, so it renders exactly as T3 Code always has. Every other palette
 * declares a small seed set (`--p-*`) that the shared derivation block expands
 * into the full token set — see the "Theme palettes" section of `index.css`.
 *
 * Adding a palette means touching three places, all of which are asserted to
 * agree by `themePalettes.test.ts`:
 *   1. `THEME_PALETTE_IDS` + `THEME_PALETTES` here,
 *   2. a `[data-theme-palette="<id>"]` seed block in `index.css`,
 *   3. the inline pre-boot allowlist in `index.html` (it cannot import).
 */
export const THEME_PALETTE_IDS = [
  "default",
  "claude",
  "codex",
  "zed",
  "midnight",
  "ember",
  "mono",
  "cyberpunk",
  "slate",
] as const;

export const ThemePaletteSchema = Schema.Literals(THEME_PALETTE_IDS);
export type ThemePalette = (typeof THEME_PALETTE_IDS)[number];

export const DEFAULT_THEME_PALETTE: ThemePalette = "default";

const THEME_PALETTE_ID_SET: ReadonlySet<string> = new Set(THEME_PALETTE_IDS);

export function isThemePalette(value: unknown): value is ThemePalette {
  return typeof value === "string" && THEME_PALETTE_ID_SET.has(value);
}

/** Falls back to the default palette instead of throwing, for storage reads. */
export function normalizeThemePalette(value: unknown): ThemePalette {
  return isThemePalette(value) ? value : DEFAULT_THEME_PALETTE;
}

/**
 * Syntax themes are named, not authored. `@pierre/theming` already registers
 * Shiki's whole bundled collection and imports each one lazily, and the worker
 * pool resolves the name on the main thread and ships the resolved theme to
 * its workers — so a palette only has to pick a good match for chat code
 * blocks, diffs, and file previews.
 *
 * `default` stays on the pierre pair it has always used, which is what keeps
 * the out-of-the-box appearance unchanged.
 */
export interface ThemePaletteSyntaxThemes {
  readonly light: string;
  readonly dark: string;
}

export interface ThemePaletteDescriptor {
  readonly id: ThemePalette;
  readonly label: string;
  /** One line, shown under the label on the settings preview card. */
  readonly description: string;
  readonly syntax: ThemePaletteSyntaxThemes;
}

/** Display order in the settings picker. */
export const THEME_PALETTES: ReadonlyArray<ThemePaletteDescriptor> = [
  {
    id: "default",
    label: "T3",
    description: "Zinc neutrals with the signature blue accent",
    syntax: { light: "pierre-light", dark: "pierre-dark" },
  },
  {
    id: "claude",
    label: "Claude",
    description: "Anthropic ivory and clay — warm and calm",
    syntax: { light: "github-light", dark: "vesper" },
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI near-black with a green accent",
    syntax: { light: "github-light-default", dark: "github-dark-default" },
  },
  {
    id: "zed",
    label: "Zed",
    description: "Zed One — muted slate with a soft blue",
    syntax: { light: "one-light", dark: "one-dark-pro" },
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Deep blue-violet with cool accents",
    syntax: { light: "catppuccin-latte", dark: "tokyo-night" },
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm crimson and bronze — forge vibes",
    syntax: { light: "gruvbox-light-soft", dark: "gruvbox-dark-medium" },
  },
  {
    id: "mono",
    label: "Mono",
    description: "Clean grayscale — minimal and focused",
    syntax: { light: "min-light", dark: "min-dark" },
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    description: "Neon green on black — matrix terminal",
    syntax: { light: "everforest-light", dark: "andromeeda" },
  },
  {
    id: "slate",
    label: "Slate",
    description: "Cool slate blue — focused developer theme",
    syntax: { light: "github-light", dark: "nord" },
  },
];

const DESCRIPTOR_BY_ID: ReadonlyMap<ThemePalette, ThemePaletteDescriptor> = new Map(
  THEME_PALETTES.map((entry) => [entry.id, entry]),
);

export function themePaletteDescriptor(palette: ThemePalette): ThemePaletteDescriptor {
  // Non-null: THEME_PALETTES is asserted to cover THEME_PALETTE_IDS in tests.
  return DESCRIPTOR_BY_ID.get(palette) ?? DESCRIPTOR_BY_ID.get(DEFAULT_THEME_PALETTE)!;
}

export function themePaletteLabel(palette: ThemePalette): string {
  return themePaletteDescriptor(palette).label;
}
