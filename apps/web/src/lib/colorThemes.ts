import { getAppSettingsSnapshot } from "../appSettings";

export interface ThemeColors {
  bg: string;
  bg2: string;
  border: string;
  accent: string;
  accent2: string;
  text: string;
  textMuted: string;
  textDim: string;
  danger: string;
  green: string;
  yellow: string;
  magenta: string;
}

export interface ColorTheme {
  id: string;
  name: string;
  colors: ThemeColors;
  interactiveOpacityRate?: number;
}

export const COLOR_THEMES: readonly ColorTheme[] = [
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    colors: {
      bg: "#080810",
      bg2: "#0c1018",
      border: "#1e2d40",
      accent: "#c8ff00",
      accent2: "#0fc5ed",
      text: "#d0e0f0",
      textMuted: "#7a9ab8",
      textDim: "#4a6580",
      danger: "#ff2e4a",
      green: "#44ffb1",
      yellow: "#ffe073",
      magenta: "#a277ff",
    },
  },
  {
    id: "josean",
    name: "Josean",
    interactiveOpacityRate: 0.7,
    colors: {
      bg: "#011423",
      bg2: "#01101c",
      border: "#033259",
      accent: "#47ff9c",
      accent2: "#0fc5ed",
      text: "#cbe0f0",
      textMuted: "#7a9ab8",
      textDim: "#4a6580",
      danger: "#e52e2e",
      green: "#44ffb1",
      yellow: "#ffe073",
      magenta: "#a277ff",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    colors: {
      bg: "#1a1b26",
      bg2: "#16161e",
      border: "#292e42",
      accent: "#7aa2f7",
      accent2: "#2ac3de",
      text: "#c0caf5",
      textMuted: "#7982a8",
      textDim: "#565d80",
      danger: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      magenta: "#bb9af7",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    colors: {
      bg: "#282a36",
      bg2: "#21222c",
      border: "#44475a",
      accent: "#bd93f9",
      accent2: "#8be9fd",
      text: "#f8f8f2",
      textMuted: "#8893b8",
      textDim: "#626580",
      danger: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      magenta: "#ff79c6",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    colors: {
      bg: "#1e1e2e",
      bg2: "#181825",
      border: "#313244",
      accent: "#cba6f7",
      accent2: "#89dceb",
      text: "#cdd6f4",
      textMuted: "#8f93a8",
      textDim: "#626478",
      danger: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      magenta: "#f5c2e7",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    colors: {
      bg: "#282828",
      bg2: "#1d2021",
      border: "#3c3836",
      accent: "#fabd2f",
      accent2: "#83a598",
      text: "#ebdbb2",
      textMuted: "#a89984",
      textDim: "#665c54",
      danger: "#fb4934",
      green: "#b8bb26",
      yellow: "#fabd2f",
      magenta: "#d3869b",
    },
  },
  {
    id: "nord",
    name: "Nord",
    colors: {
      bg: "#2e3440",
      bg2: "#272c36",
      border: "#3b4252",
      accent: "#88c0d0",
      accent2: "#81a1c1",
      text: "#eceff4",
      textMuted: "#9aa5b4",
      textDim: "#616e7c",
      danger: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      magenta: "#b48ead",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    colors: {
      bg: "#282c34",
      bg2: "#21252b",
      border: "#3e4452",
      accent: "#61afef",
      accent2: "#56b6c2",
      text: "#abb2bf",
      textMuted: "#7f848e",
      textDim: "#5c6370",
      danger: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      magenta: "#c678dd",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    colors: {
      bg: "#002b36",
      bg2: "#00252f",
      border: "#073642",
      accent: "#b58900",
      accent2: "#268bd2",
      text: "#839496",
      textMuted: "#657b83",
      textDim: "#586e75",
      danger: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      magenta: "#d33682",
    },
  },
  {
    id: "rose-pine",
    name: "Rose Pine",
    colors: {
      bg: "#191724",
      bg2: "#1f1d2e",
      border: "#26233a",
      accent: "#ebbcba",
      accent2: "#31748f",
      text: "#e0def4",
      textMuted: "#908caa",
      textDim: "#6e6a86",
      danger: "#eb6f92",
      green: "#9ccfd8",
      yellow: "#f6c177",
      magenta: "#c4a7e7",
    },
  },
  {
    id: "kanagawa",
    name: "Kanagawa",
    colors: {
      bg: "#1f1f28",
      bg2: "#16161d",
      border: "#2a2a37",
      accent: "#dca561",
      accent2: "#7e9cd8",
      text: "#dcd7ba",
      textMuted: "#9a9a8e",
      textDim: "#727169",
      danger: "#e82424",
      green: "#98bb6c",
      yellow: "#e6c384",
      magenta: "#957fb8",
    },
  },
] as const;

const CSS_VAR_KEYS = [
  "--background",
  "--card",
  "--popover",
  "--border",
  "--primary",
  "--ring",
  "--secondary",
  "--muted",
  "--accent",
  "--foreground",
  "--card-foreground",
  "--popover-foreground",
  "--primary-foreground",
  "--muted-foreground",
  "--secondary-foreground",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--info",
  "--info-foreground",
  "--input",
] as const;

function hexToAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Mix two hex colors. ratio 0 = pure a, 1 = pure b. */
function mixHex(a: string, b: string, ratio: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * ratio);
  const g = Math.round(ag + (bg - ag) * ratio);
  const bl = Math.round(ab + (bb - ab) * ratio);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

export function getColorThemeById(id: string): ColorTheme | undefined {
  return COLOR_THEMES.find((theme) => theme.id === id);
}

export function applyColorTheme(themeId: string | null | undefined, wallpaperActive = false): void {
  const root = document.documentElement;

  if (!themeId) {
    for (const key of CSS_VAR_KEYS) {
      root.style.removeProperty(key);
    }
    return;
  }

  const theme = getColorThemeById(themeId);
  if (!theme) return;

  const { colors } = theme;

  // When wallpaper is active, boost muted/dim text toward the main text color
  const textMuted = wallpaperActive ? mixHex(colors.textMuted, colors.text, 0.3) : colors.textMuted;
  const textDim = wallpaperActive ? mixHex(colors.textDim, colors.text, 0.3) : colors.textDim;

  root.style.setProperty("--background", colors.bg);
  root.style.setProperty("--card", colors.bg2);
  root.style.setProperty("--popover", colors.bg2);
  root.style.setProperty("--border", colors.border);
  root.style.setProperty("--primary", colors.accent);
  root.style.setProperty("--ring", colors.accent);
  root.style.setProperty("--secondary", hexToAlpha(colors.accent2, 0.12));
  root.style.setProperty("--muted", hexToAlpha(colors.accent2, 0.12));
  root.style.setProperty("--accent", hexToAlpha(colors.accent2, 0.12));
  root.style.setProperty("--foreground", colors.text);
  root.style.setProperty("--card-foreground", colors.text);
  root.style.setProperty("--popover-foreground", colors.text);
  root.style.setProperty("--primary-foreground", colors.text);
  root.style.setProperty("--muted-foreground", textMuted);
  root.style.setProperty("--secondary-foreground", textDim);
  root.style.setProperty("--accent-foreground", textDim);
  root.style.setProperty("--destructive", colors.danger);
  root.style.setProperty("--destructive-foreground", colors.danger);
  root.style.setProperty("--success", colors.green);
  root.style.setProperty("--success-foreground", colors.green);
  root.style.setProperty("--warning", colors.yellow);
  root.style.setProperty("--warning-foreground", colors.yellow);
  root.style.setProperty("--info", colors.magenta);
  root.style.setProperty("--info-foreground", colors.magenta);
  root.style.setProperty("--input", hexToAlpha(colors.border, 0.8));
}

export function getInteractiveOpacityRate(themeId: string | undefined): number {
  if (!themeId) return 0.55;
  return getColorThemeById(themeId)?.interactiveOpacityRate ?? 0.55;
}

/** Single-layer elements (sidebar) that sit directly over the wallpaper */
export function interactiveOpacity(panelOpacity: number, rate = 0.55): number {
  return 1 - (1 - panelOpacity) * rate;
}

/** Elements nested inside the panel — subtle bg2 tint, not a full opaque layer */
export function nestedOpacity(panelOpacity: number, rate = 0.55): number {
  return panelOpacity * rate;
}

// Eager application at module load: apply color theme if dark mode is active
{
  const settings = getAppSettingsSnapshot();
  if (settings.colorThemeId && document.documentElement.classList.contains("dark")) {
    applyColorTheme(settings.colorThemeId, !!settings.backgroundImage);
  }
}
