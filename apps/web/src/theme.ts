import type { DesktopTheme } from "@forma/contracts";

export const THEME_STORAGE_KEY = "forma:theme";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export type ResolvedThemeMode = "light" | "dark";
export type ResolvedThemePreset = "light" | "noir" | "dawn" | "dusk" | "midnight" | "stone";
export type ThemePreference = "system" | ResolvedThemePreset;

export type ThemeOption = {
  value: ThemePreference;
  label: string;
};

export type ThemeTerminalPalette = {
  cursor: string;
  selectionBackground: string;
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

type ThemeMetadata = {
  label: string;
  mode: ResolvedThemeMode;
  chromeColor: string;
  foregroundColor: string;
  desktopTheme: Exclude<DesktopTheme, "system">;
  monacoTheme: "vs" | "vs-dark";
  diffThemeFamily: "light" | "dark";
  iconTheme: "light" | "dark";
  terminalPalette: ResolvedThemePreset;
};

type ThemeStorageLike = Pick<Storage, "getItem" | "setItem">;
type DocumentLike = Pick<Document, "querySelector" | "createElement" | "head" | "body"> & {
  documentElement: HTMLElement;
};

const LIGHT_THEME_PRESETS = new Set<ResolvedThemePreset>(["light", "dawn", "dusk"]);
const RESOLVED_THEME_PRESETS = new Set<ResolvedThemePreset>([
  "light",
  "noir",
  "dawn",
  "dusk",
  "midnight",
  "stone",
]);
const THEME_PREFERENCES = new Set<ThemePreference>(["system", ...RESOLVED_THEME_PRESETS]);

const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "noir", label: "Noir" },
  { value: "dawn", label: "Dawn" },
  { value: "dusk", label: "Dusk" },
  { value: "midnight", label: "Midnight" },
  { value: "stone", label: "Stone" },
] as const;

export const THEME_TERMINAL_PALETTES: Record<ResolvedThemePreset, ThemeTerminalPalette> = {
  light: {
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  },
  noir: {
    cursor: "rgb(180, 203, 255)",
    selectionBackground: "rgba(180, 203, 255, 0.25)",
    scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
    scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
    scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
    black: "rgb(24, 30, 38)",
    red: "rgb(255, 122, 142)",
    green: "rgb(134, 231, 149)",
    yellow: "rgb(244, 205, 114)",
    blue: "rgb(137, 190, 255)",
    magenta: "rgb(208, 176, 255)",
    cyan: "rgb(124, 232, 237)",
    white: "rgb(210, 218, 230)",
    brightBlack: "rgb(110, 120, 136)",
    brightRed: "rgb(255, 168, 180)",
    brightGreen: "rgb(176, 245, 186)",
    brightYellow: "rgb(255, 224, 149)",
    brightBlue: "rgb(174, 210, 255)",
    brightMagenta: "rgb(229, 203, 255)",
    brightCyan: "rgb(167, 244, 247)",
    brightWhite: "rgb(244, 247, 252)",
  },
  dawn: {
    cursor: "rgb(122, 82, 45)",
    selectionBackground: "rgba(212, 163, 107, 0.24)",
    scrollbarSliderBackground: "rgba(79, 45, 22, 0.14)",
    scrollbarSliderHoverBackground: "rgba(79, 45, 22, 0.22)",
    scrollbarSliderActiveBackground: "rgba(79, 45, 22, 0.28)",
    black: "rgb(77, 58, 50)",
    red: "rgb(194, 103, 95)",
    green: "rgb(102, 137, 91)",
    yellow: "rgb(185, 145, 70)",
    blue: "rgb(95, 121, 173)",
    magenta: "rgb(166, 108, 146)",
    cyan: "rgb(86, 139, 138)",
    white: "rgb(229, 220, 211)",
    brightBlack: "rgb(128, 109, 100)",
    brightRed: "rgb(214, 124, 116)",
    brightGreen: "rgb(124, 159, 113)",
    brightYellow: "rgb(205, 165, 89)",
    brightBlue: "rgb(118, 143, 193)",
    brightMagenta: "rgb(187, 129, 166)",
    brightCyan: "rgb(106, 159, 158)",
    brightWhite: "rgb(244, 236, 229)",
  },
  dusk: {
    cursor: "rgb(114, 67, 58)",
    selectionBackground: "rgba(191, 111, 91, 0.2)",
    scrollbarSliderBackground: "rgba(74, 39, 34, 0.14)",
    scrollbarSliderHoverBackground: "rgba(74, 39, 34, 0.22)",
    scrollbarSliderActiveBackground: "rgba(74, 39, 34, 0.28)",
    black: "rgb(74, 51, 48)",
    red: "rgb(185, 88, 81)",
    green: "rgb(94, 128, 94)",
    yellow: "rgb(180, 131, 64)",
    blue: "rgb(97, 117, 168)",
    magenta: "rgb(154, 98, 141)",
    cyan: "rgb(90, 132, 136)",
    white: "rgb(226, 214, 210)",
    brightBlack: "rgb(125, 102, 99)",
    brightRed: "rgb(207, 109, 101)",
    brightGreen: "rgb(115, 149, 115)",
    brightYellow: "rgb(200, 152, 86)",
    brightBlue: "rgb(120, 139, 189)",
    brightMagenta: "rgb(176, 118, 162)",
    brightCyan: "rgb(109, 151, 155)",
    brightWhite: "rgb(243, 234, 230)",
  },
  midnight: {
    cursor: "rgb(188, 208, 240)",
    selectionBackground: "rgba(144, 167, 204, 0.24)",
    scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
    scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
    scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
    black: "rgb(27, 34, 43)",
    red: "rgb(224, 118, 129)",
    green: "rgb(132, 183, 153)",
    yellow: "rgb(208, 177, 113)",
    blue: "rgb(131, 171, 226)",
    magenta: "rgb(182, 151, 219)",
    cyan: "rgb(121, 187, 197)",
    white: "rgb(214, 222, 233)",
    brightBlack: "rgb(102, 113, 128)",
    brightRed: "rgb(240, 146, 157)",
    brightGreen: "rgb(160, 204, 178)",
    brightYellow: "rgb(226, 195, 135)",
    brightBlue: "rgb(158, 193, 242)",
    brightMagenta: "rgb(204, 175, 236)",
    brightCyan: "rgb(147, 209, 220)",
    brightWhite: "rgb(242, 246, 252)",
  },
  stone: {
    cursor: "rgb(234, 196, 177)",
    selectionBackground: "rgba(181, 113, 88, 0.24)",
    scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
    scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
    scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
    black: "rgb(39, 29, 27)",
    red: "rgb(219, 116, 102)",
    green: "rgb(144, 171, 122)",
    yellow: "rgb(203, 160, 94)",
    blue: "rgb(132, 157, 197)",
    magenta: "rgb(183, 135, 171)",
    cyan: "rgb(118, 168, 161)",
    white: "rgb(222, 214, 206)",
    brightBlack: "rgb(113, 98, 92)",
    brightRed: "rgb(234, 143, 129)",
    brightGreen: "rgb(168, 194, 146)",
    brightYellow: "rgb(222, 182, 118)",
    brightBlue: "rgb(155, 179, 220)",
    brightMagenta: "rgb(203, 157, 190)",
    brightCyan: "rgb(143, 190, 184)",
    brightWhite: "rgb(245, 239, 233)",
  },
};

export const THEME_METADATA_BY_PRESET: Record<ResolvedThemePreset, ThemeMetadata> = {
  light: {
    label: "Light",
    mode: "light",
    chromeColor: "#ffffff",
    foregroundColor: "#262626",
    desktopTheme: "light",
    monacoTheme: "vs",
    diffThemeFamily: "light",
    iconTheme: "light",
    terminalPalette: "light",
  },
  noir: {
    label: "Noir",
    mode: "dark",
    chromeColor: "#161616",
    foregroundColor: "#f5f5f5",
    desktopTheme: "dark",
    monacoTheme: "vs-dark",
    diffThemeFamily: "dark",
    iconTheme: "dark",
    terminalPalette: "noir",
  },
  dawn: {
    label: "Dawn",
    mode: "light",
    chromeColor: "#f6ebe2",
    foregroundColor: "#42352e",
    desktopTheme: "light",
    monacoTheme: "vs",
    diffThemeFamily: "light",
    iconTheme: "light",
    terminalPalette: "dawn",
  },
  dusk: {
    label: "Dusk",
    mode: "light",
    chromeColor: "#f5e8e3",
    foregroundColor: "#47312d",
    desktopTheme: "light",
    monacoTheme: "vs",
    diffThemeFamily: "light",
    iconTheme: "light",
    terminalPalette: "dusk",
  },
  midnight: {
    label: "Midnight",
    mode: "dark",
    chromeColor: "#171b22",
    foregroundColor: "#edf2fb",
    desktopTheme: "dark",
    monacoTheme: "vs-dark",
    diffThemeFamily: "dark",
    iconTheme: "dark",
    terminalPalette: "midnight",
  },
  stone: {
    label: "Stone",
    mode: "dark",
    chromeColor: "#211917",
    foregroundColor: "#f1ece6",
    desktopTheme: "dark",
    monacoTheme: "vs-dark",
    diffThemeFamily: "dark",
    iconTheme: "dark",
    terminalPalette: "stone",
  },
};

export function isResolvedThemePreset(value: unknown): value is ResolvedThemePreset {
  return typeof value === "string" && RESOLVED_THEME_PRESETS.has(value as ResolvedThemePreset);
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEME_PREFERENCES.has(value as ThemePreference);
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  if (value === "dark") {
    return "noir";
  }
  return isThemePreference(value) ? value : "system";
}

export function readStoredThemePreference(storage?: ThemeStorageLike | null): ThemePreference {
  const targetStorage =
    storage ?? (typeof localStorage !== "undefined" ? (localStorage as ThemeStorageLike) : null);
  if (!targetStorage) {
    return "system";
  }

  const raw = targetStorage.getItem(THEME_STORAGE_KEY);
  const theme = normalizeThemePreference(raw);
  if (raw === "dark") {
    targetStorage.setItem(THEME_STORAGE_KEY, theme);
  }
  return theme;
}

export function resolveThemePreset(
  theme: ThemePreference | string | null | undefined,
  systemDark = false,
): ResolvedThemePreset {
  const normalizedTheme = normalizeThemePreference(theme);
  if (normalizedTheme === "system") {
    return systemDark ? "noir" : "light";
  }
  return normalizedTheme;
}

export function resolveThemeMode(
  theme: ThemePreference | ResolvedThemePreset | string | null | undefined,
  systemDark = false,
): ResolvedThemeMode {
  const resolvedPreset = resolveThemePreset(theme, systemDark);
  return LIGHT_THEME_PRESETS.has(resolvedPreset) ? "light" : "dark";
}

export function getThemeMetadata(
  theme: ThemePreference | ResolvedThemePreset | string | null | undefined,
  systemDark = false,
): ThemeMetadata {
  const resolvedPreset = resolveThemePreset(theme, systemDark);
  return THEME_METADATA_BY_PRESET[resolvedPreset];
}

export function resolveDesktopTheme(theme: ThemePreference): DesktopTheme {
  if (theme === "system") {
    return "system";
  }
  return getThemeMetadata(theme).desktopTheme;
}

export function resolveTerminalThemePalette(
  theme: ThemePreference | ResolvedThemePreset | string | null | undefined,
  systemDark = false,
): ThemeTerminalPalette {
  const metadata = getThemeMetadata(theme, systemDark);
  return THEME_TERMINAL_PALETTES[metadata.terminalPalette];
}

export function ensureThemeColorMetaTag(
  targetDocument?: DocumentLike | null,
): HTMLMetaElement | null {
  const safeDocument =
    targetDocument ?? (typeof document !== "undefined" ? (document as DocumentLike) : null);
  if (!safeDocument?.head || typeof safeDocument.createElement !== "function") {
    return null;
  }

  const existing = safeDocument.querySelector(
    DYNAMIC_THEME_COLOR_SELECTOR,
  ) as HTMLMetaElement | null;
  if (existing) {
    return existing;
  }

  const element = safeDocument.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  safeDocument.head.append(element);
  return element;
}

export function setDynamicThemeColor(color: string, targetDocument?: DocumentLike | null): void {
  const themeColorMeta = ensureThemeColorMetaTag(targetDocument);
  themeColorMeta?.setAttribute("content", color);
}

export function readResolvedThemePresetFromDocument(
  targetDocument?: Pick<Document, "documentElement"> | null,
): ResolvedThemePreset {
  const safeDocument = targetDocument ?? (typeof document !== "undefined" ? document : null);
  const datasetTheme = safeDocument?.documentElement.dataset.theme;
  if (isResolvedThemePreset(datasetTheme)) {
    return datasetTheme;
  }
  return safeDocument?.documentElement.classList.contains("dark") ? "noir" : "light";
}

export function readResolvedThemeModeFromDocument(
  targetDocument?: Pick<Document, "documentElement"> | null,
): ResolvedThemeMode {
  return getThemeMetadata(readResolvedThemePresetFromDocument(targetDocument)).mode;
}

export function applyThemePreferenceToDocument(
  theme: ThemePreference,
  options?: {
    document?: DocumentLike | null;
    systemDark?: boolean;
  },
): ResolvedThemePreset {
  const safeDocument =
    options?.document ?? (typeof document !== "undefined" ? (document as DocumentLike) : null);
  if (!safeDocument) {
    return resolveThemePreset(theme, options?.systemDark ?? false);
  }

  const resolvedPreset = resolveThemePreset(theme, options?.systemDark ?? false);
  const metadata = getThemeMetadata(resolvedPreset);
  const root = safeDocument.documentElement;
  const isDark = metadata.mode === "dark";

  root.classList.toggle("dark", isDark);
  root.dataset.theme = resolvedPreset;
  root.dataset.themePreference = theme;
  root.style.backgroundColor = metadata.chromeColor;

  if (safeDocument.body) {
    safeDocument.body.style.backgroundColor = metadata.chromeColor;
  }

  setDynamicThemeColor(metadata.chromeColor, safeDocument);
  return resolvedPreset;
}
