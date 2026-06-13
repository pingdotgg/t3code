export const THEME_PALETTES = [
  {
    id: "noctalia",
    label: "Noctalia",
    dark: ["#fff59b", "#a9aefe", "#9bfece", "#070722"],
    light: ["#5d65f5", "#8e93d8", "#0e0e43", "#e6e8fa"],
  },
  {
    id: "ayu",
    label: "Ayu",
    dark: ["#e6b450", "#aad94c", "#39bae6", "#0b0e14"],
    light: ["#ff8f40", "#86b300", "#55b4d4", "#f8f9fa"],
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    dark: ["#cba6f7", "#fab387", "#94e2d5", "#1e1e2e"],
    light: ["#8839ef", "#fe640b", "#40a02b", "#eff1f5"],
  },
  {
    id: "dracula",
    label: "Dracula",
    dark: ["#bd93f9", "#ff79c6", "#8be9fd", "#282a36"],
    light: ["#8332f4", "#ff1399", "#0398b9", "#f8f8f2"],
  },
  {
    id: "eldritch",
    label: "Eldritch",
    dark: ["#37f499", "#04d1f9", "#a48cf2", "#212337"],
    light: ["#37f499", "#04d1f9", "#a48cf2", "#ffffff"],
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    dark: ["#b8bb26", "#fabd2f", "#83a598", "#282828"],
    light: ["#98971a", "#d79921", "#458588", "#fbf1c7"],
  },
  {
    id: "kanagawa",
    label: "Kanagawa",
    dark: ["#76946a", "#c0a36e", "#7e9cd8", "#1f1f28"],
    light: ["#6f894e", "#77713f", "#4d699b", "#f2ecbc"],
  },
  {
    id: "nord",
    label: "Nord",
    dark: ["#8fbcbb", "#88c0d0", "#5e81ac", "#2e3440"],
    light: ["#5e81ac", "#64adc2", "#6fa9a8", "#eceff4"],
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    dark: ["#ebbcba", "#9ccfd8", "#31748f", "#191724"],
    light: ["#d7827e", "#56949f", "#286983", "#fffaf3"],
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    dark: ["#7aa2f7", "#bb9af7", "#9ece6a", "#1a1b26"],
    light: ["#2e7de9", "#9854f1", "#587539", "#e1e2e7"],
  },
] as const;

export type ThemePalette = (typeof THEME_PALETTES)[number]["id"];

export const DEFAULT_THEME_PALETTE: ThemePalette = "noctalia";

export function isThemePalette(value: unknown): value is ThemePalette {
  return THEME_PALETTES.some((palette) => palette.id === value);
}

export function getThemePalette(paletteId: ThemePalette) {
  return THEME_PALETTES.find((palette) => palette.id === paletteId) ?? THEME_PALETTES[0];
}
