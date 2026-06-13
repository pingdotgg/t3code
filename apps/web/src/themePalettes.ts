/**
 * Full theme-palette definitions.
 *
 * This file is the single source of truth for both the UI swatches and the
 * generated CSS in `themePalettes.css`. If you add or edit a palette, run
 * `pnpm --filter @t3tools/web generate:theme-css` (or `vp run generate:theme-css`
 * from `apps/web`) to regenerate the CSS, then commit both files.
 *
 * Also update the `VALID_PALETTES` set in `apps/web/index.html` so the boot
 * script can apply the palette before the app bundle loads.
 */
export interface ThemePaletteColors {
  readonly primary: string;
  readonly onPrimary: string;
  readonly secondary: string;
  readonly onSecondary: string;
  readonly tertiary: string;
  readonly onTertiary: string;
  readonly error: string;
  readonly surface: string;
  readonly onSurface: string;
  readonly surfaceVariant: string;
  readonly onSurfaceVariant: string;
  readonly outline: string;
}

export interface ThemePaletteDefinition {
  readonly id: string;
  readonly label: string;
  readonly dark: ThemePaletteColors;
  readonly light: ThemePaletteColors;
}

export const THEME_PALETTES: ReadonlyArray<ThemePaletteDefinition> = [
  {
    id: "noctalia",
    label: "Noctalia",
    dark: {
      primary: "#fff59b",
      onPrimary: "#0e0e43",
      secondary: "#a9aefe",
      onSecondary: "#0e0e43",
      tertiary: "#9bfece",
      onTertiary: "#0e0e43",
      error: "#fd4663",
      surface: "#070722",
      onSurface: "#f3edf7",
      surfaceVariant: "#11112d",
      onSurfaceVariant: "#7c80b4",
      outline: "#21215f",
    },
    light: {
      primary: "#5d65f5",
      onPrimary: "#dadcff",
      secondary: "#8e93d8",
      onSecondary: "#dadcff",
      tertiary: "#0e0e43",
      onTertiary: "#fef29a",
      error: "#fd4663",
      surface: "#e6e8fa",
      onSurface: "#0e0e43",
      surfaceVariant: "#eff0ff",
      onSurfaceVariant: "#4b55c8",
      outline: "#8288fc",
    },
  },
  {
    id: "ayu",
    label: "Ayu",
    dark: {
      primary: "#e6b450",
      onPrimary: "#0b0e14",
      secondary: "#aad94c",
      onSecondary: "#0b0e14",
      tertiary: "#39bae6",
      onTertiary: "#0b0e14",
      error: "#d95757",
      surface: "#0b0e14",
      onSurface: "#d1d1c7",
      surfaceVariant: "#1e222a",
      onSurfaceVariant: "#8e959e",
      outline: "#565b66",
    },
    light: {
      primary: "#ff8f40",
      onPrimary: "#f8f9fa",
      secondary: "#86b300",
      onSecondary: "#f8f9fa",
      tertiary: "#55b4d4",
      onTertiary: "#f8f9fa",
      error: "#e65050",
      surface: "#f8f9fa",
      onSurface: "#42474c",
      surfaceVariant: "#e4e6e9",
      onSurfaceVariant: "#6e757c",
      outline: "#8a9199",
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    dark: {
      primary: "#cba6f7",
      onPrimary: "#11111b",
      secondary: "#fab387",
      onSecondary: "#11111b",
      tertiary: "#94e2d5",
      onTertiary: "#11111b",
      error: "#f38ba8",
      surface: "#1e1e2e",
      onSurface: "#cdd6f4",
      surfaceVariant: "#313244",
      onSurfaceVariant: "#a3b4eb",
      outline: "#4c4f69",
    },
    light: {
      primary: "#8839ef",
      onPrimary: "#eff1f5",
      secondary: "#fe640b",
      onSecondary: "#eff1f5",
      tertiary: "#40a02b",
      onTertiary: "#eff1f5",
      error: "#d20f39",
      surface: "#eff1f5",
      onSurface: "#4c4f69",
      surfaceVariant: "#ccd0da",
      onSurfaceVariant: "#6c6f85",
      outline: "#a5adcb",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    dark: {
      primary: "#bd93f9",
      onPrimary: "#282a36",
      secondary: "#ff79c6",
      onSecondary: "#4e1d32",
      tertiary: "#8be9fd",
      onTertiary: "#003543",
      error: "#ff5555",
      surface: "#282a36",
      onSurface: "#f8f8f2",
      surfaceVariant: "#44475a",
      onSurfaceVariant: "#d6d8e0",
      outline: "#5a5e77",
    },
    light: {
      primary: "#8332f4",
      onPrimary: "#ffffff",
      secondary: "#ff1399",
      onSecondary: "#ffffff",
      tertiary: "#0398b9",
      onTertiary: "#ffffff",
      error: "#ff5555",
      surface: "#f8f8f2",
      onSurface: "#282a36",
      surfaceVariant: "#e6e6ea",
      onSurfaceVariant: "#44475a",
      outline: "#cacad3",
    },
  },
  {
    id: "eldritch",
    label: "Eldritch",
    dark: {
      primary: "#37f499",
      onPrimary: "#171928",
      secondary: "#04d1f9",
      onSecondary: "#171928",
      tertiary: "#a48cf2",
      onTertiary: "#171928",
      error: "#f16c75",
      surface: "#212337",
      onSurface: "#ebfafa",
      surfaceVariant: "#292e42",
      onSurfaceVariant: "#abb4da",
      outline: "#3b4261",
    },
    light: {
      primary: "#37f499",
      onPrimary: "#171928",
      secondary: "#04d1f9",
      onSecondary: "#171928",
      tertiary: "#a48cf2",
      onTertiary: "#171928",
      error: "#f16c75",
      surface: "#ffffff",
      onSurface: "#171928",
      surfaceVariant: "#f2f4f8",
      onSurfaceVariant: "#3b4261",
      outline: "#b0b6c3",
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    dark: {
      primary: "#b8bb26",
      onPrimary: "#282828",
      secondary: "#fabd2f",
      onSecondary: "#282828",
      tertiary: "#83a598",
      onTertiary: "#282828",
      error: "#fb4934",
      surface: "#282828",
      onSurface: "#fbf1c7",
      surfaceVariant: "#3c3836",
      onSurfaceVariant: "#ebdbb2",
      outline: "#57514e",
    },
    light: {
      primary: "#98971a",
      onPrimary: "#fbf1c7",
      secondary: "#d79921",
      onSecondary: "#fbf1c7",
      tertiary: "#458588",
      onTertiary: "#fbf1c7",
      error: "#cc241d",
      surface: "#fbf1c7",
      onSurface: "#3c3836",
      surfaceVariant: "#ebdbb2",
      onSurfaceVariant: "#7c6f64",
      outline: "#bdae93",
    },
  },
  {
    id: "kanagawa",
    label: "Kanagawa",
    dark: {
      primary: "#76946a",
      onPrimary: "#1f1f28",
      secondary: "#c0a36e",
      onSecondary: "#1f1f28",
      tertiary: "#7e9cd8",
      onTertiary: "#1f1f28",
      error: "#c34043",
      surface: "#1f1f28",
      onSurface: "#c8c093",
      surfaceVariant: "#2a2a37",
      onSurfaceVariant: "#717c7c",
      outline: "#363646",
    },
    light: {
      primary: "#6f894e",
      onPrimary: "#f2ecbc",
      secondary: "#77713f",
      onSecondary: "#f2ecbc",
      tertiary: "#4d699b",
      onTertiary: "#f2ecbc",
      error: "#c84053",
      surface: "#f2ecbc",
      onSurface: "#545464",
      surfaceVariant: "#e5ddb0",
      onSurfaceVariant: "#8a8980",
      outline: "#cfc49c",
    },
  },
  {
    id: "nord",
    label: "Nord",
    dark: {
      primary: "#8fbcbb",
      onPrimary: "#2e3440",
      secondary: "#88c0d0",
      onSecondary: "#2e3440",
      tertiary: "#5e81ac",
      onTertiary: "#2e3440",
      error: "#bf616a",
      surface: "#2e3440",
      onSurface: "#eceff4",
      surfaceVariant: "#3b4252",
      onSurfaceVariant: "#d8dee9",
      outline: "#505a70",
    },
    light: {
      primary: "#5e81ac",
      onPrimary: "#eceff4",
      secondary: "#64adc2",
      onSecondary: "#eceff4",
      tertiary: "#6fa9a8",
      onTertiary: "#eceff4",
      error: "#bf616a",
      surface: "#eceff4",
      onSurface: "#2e3440",
      surfaceVariant: "#e5e9f0",
      onSurfaceVariant: "#4c566a",
      outline: "#c5cedd",
    },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    dark: {
      primary: "#ebbcba",
      onPrimary: "#191724",
      secondary: "#9ccfd8",
      onSecondary: "#191724",
      tertiary: "#31748f",
      onTertiary: "#e0def4",
      error: "#eb6f92",
      surface: "#191724",
      onSurface: "#e0def4",
      surfaceVariant: "#26233a",
      onSurfaceVariant: "#908caa",
      outline: "#403d52",
    },
    light: {
      primary: "#d7827e",
      onPrimary: "#faf4ed",
      secondary: "#56949f",
      onSecondary: "#faf4ed",
      tertiary: "#286983",
      onTertiary: "#faf4ed",
      error: "#b4637a",
      surface: "#fffaf3",
      onSurface: "#575279",
      surfaceVariant: "#f2e9e1",
      onSurfaceVariant: "#797593",
      outline: "#dfdad9",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    dark: {
      primary: "#7aa2f7",
      onPrimary: "#16161e",
      secondary: "#bb9af7",
      onSecondary: "#16161e",
      tertiary: "#9ece6a",
      onTertiary: "#16161e",
      error: "#f7768e",
      surface: "#1a1b26",
      onSurface: "#c0caf5",
      surfaceVariant: "#24283b",
      onSurfaceVariant: "#9aa5ce",
      outline: "#353d57",
    },
    light: {
      primary: "#2e7de9",
      onPrimary: "#e1e2e7",
      secondary: "#9854f1",
      onSecondary: "#e1e2e7",
      tertiary: "#587539",
      onTertiary: "#e1e2e7",
      error: "#f52a65",
      surface: "#e1e2e7",
      onSurface: "#3760bf",
      surfaceVariant: "#d0d5e3",
      onSurfaceVariant: "#6172b0",
      outline: "#b4b5b9",
    },
  },
] as const satisfies ReadonlyArray<ThemePaletteDefinition>;

export type ThemePalette = (typeof THEME_PALETTES)[number]["id"];

export const DEFAULT_THEME_PALETTE: ThemePalette = "noctalia";

export function isThemePalette(value: unknown): value is ThemePalette {
  return THEME_PALETTES.some((palette) => palette.id === value);
}

export function getThemePalette(paletteId: ThemePalette): ThemePaletteDefinition {
  return (
    THEME_PALETTES.find((palette) => palette.id === paletteId) ??
    // THEME_PALETTES is non-empty and contains DEFAULT_THEME_PALETTE, so the
    // fallback is always defined.
    THEME_PALETTES[0]!
  );
}

/**
 * Returns the three preview colors (primary, secondary, tertiary) used for the
 * palette swatch in the settings dropdown.
 */
export function getThemePalettePreviewColors(
  paletteId: ThemePalette,
  resolvedTheme: "light" | "dark",
): readonly [string, string, string] {
  const colors = getThemePalette(paletteId)[resolvedTheme];
  return [colors.primary, colors.secondary, colors.tertiary];
}
