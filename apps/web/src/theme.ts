import type { DesktopTheme } from "@forma/contracts";

export const THEME_STORAGE_KEY = "forma:theme";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedThemeMode = "light" | "dark";

export type CustomThemeSettings = {
  mode: ThemeMode;
  hue: number;
  saturation: number;
};

export type PersistedThemeDocument = {
  version: 2;
  mode: ThemeMode;
  hue: number;
  saturation: number;
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

export type GeneratedTheme = {
  theme: CustomThemeSettings;
  resolvedMode: ResolvedThemeMode;
  chromeColor: string;
  foregroundColor: string;
  monacoTheme: "vs" | "vs-dark";
  diffThemeFamily: ResolvedThemeMode;
  desktopTheme: DesktopTheme;
  iconTheme: ResolvedThemeMode;
  terminalPalette: ThemeTerminalPalette;
  cssVariables: Record<string, string>;
};

type ThemeStorageLike = Pick<Storage, "getItem" | "setItem">;
type DocumentLike = Pick<Document, "querySelector" | "createElement" | "head" | "body"> & {
  documentElement: HTMLElement;
};

export const DEFAULT_THEME_HUE = 222;
export const DEFAULT_THEME_SATURATION = 68;
export const DEFAULT_CUSTOM_THEME_SETTINGS: CustomThemeSettings = {
  mode: "system",
  hue: DEFAULT_THEME_HUE,
  saturation: DEFAULT_THEME_SATURATION,
};

export const MIN_THEME_HUE = 0;
export const MAX_THEME_HUE = 359;
export const MIN_THEME_SATURATION = 0;
export const MAX_THEME_SATURATION = 100;

const LEGACY_THEME_PREFERENCES = new Set([
  "light",
  "noir",
  "dawn",
  "dusk",
  "midnight",
  "stone",
  "blueberry",
  "cosmic",
  "dark",
  "slate",
]);

const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeHue(value: unknown): number {
  return clamp(Math.round(Number(value) || DEFAULT_THEME_HUE), MIN_THEME_HUE, MAX_THEME_HUE);
}

function normalizeSaturation(value: unknown): number {
  return clamp(
    Math.round(Number(value) || DEFAULT_THEME_SATURATION),
    MIN_THEME_SATURATION,
    MAX_THEME_SATURATION,
  );
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function normalizeThemeSettings(
  value: Partial<CustomThemeSettings> | null | undefined,
): CustomThemeSettings {
  return {
    mode: normalizeThemeMode(value?.mode),
    hue: normalizeHue(value?.hue),
    saturation: normalizeSaturation(value?.saturation),
  };
}

function toPersistedThemeDocument(theme: CustomThemeSettings): PersistedThemeDocument {
  const normalized = normalizeThemeSettings(theme);
  return {
    version: 2,
    mode: normalized.mode,
    hue: normalized.hue,
    saturation: normalized.saturation,
  };
}

export function resolveThemeMode(
  theme: CustomThemeSettings | ThemeMode | string | null | undefined,
  systemDark = false,
): ResolvedThemeMode {
  if (typeof theme === "string") {
    const mode = normalizeThemeMode(theme);
    return mode === "system" ? (systemDark ? "dark" : "light") : mode;
  }
  const normalized = normalizeThemeSettings(theme);
  return normalized.mode === "system" ? (systemDark ? "dark" : "light") : normalized.mode;
}

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${Math.round(hue)} ${Math.round(clamp(saturation, 0, 100))}% ${Math.round(
    clamp(lightness, 0, 100),
  )}%)`;
}

function hsla(hue: number, saturation: number, lightness: number, alpha: number): string {
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));
  return `hsla(${Math.round(hue)} ${Math.round(clamp(saturation, 0, 100))}% ${Math.round(
    clamp(lightness, 0, 100),
  )}% / ${normalizedAlpha})`;
}

function buildThemeTerminalPalette(resolvedMode: ResolvedThemeMode): ThemeTerminalPalette {
  if (resolvedMode === "dark") {
    return {
      cursor: "rgb(232, 236, 242)",
      selectionBackground: "rgba(148, 163, 184, 0.22)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.24)",
      black: "rgb(17, 24, 39)",
      red: "rgb(248, 113, 113)",
      green: "rgb(74, 222, 128)",
      yellow: "rgb(250, 204, 21)",
      blue: "rgb(96, 165, 250)",
      magenta: "rgb(217, 70, 239)",
      cyan: "rgb(34, 211, 238)",
      white: "rgb(203, 213, 225)",
      brightBlack: "rgb(71, 85, 105)",
      brightRed: "rgb(252, 165, 165)",
      brightGreen: "rgb(134, 239, 172)",
      brightYellow: "rgb(253, 224, 71)",
      brightBlue: "rgb(147, 197, 253)",
      brightMagenta: "rgb(232, 121, 249)",
      brightCyan: "rgb(103, 232, 249)",
      brightWhite: "rgb(248, 250, 252)",
    };
  }

  return {
    cursor: "rgb(15, 23, 42)",
    selectionBackground: "rgba(148, 163, 184, 0.18)",
    scrollbarSliderBackground: "rgba(15, 23, 42, 0.12)",
    scrollbarSliderHoverBackground: "rgba(15, 23, 42, 0.18)",
    scrollbarSliderActiveBackground: "rgba(15, 23, 42, 0.24)",
    black: "rgb(30, 41, 59)",
    red: "rgb(220, 38, 38)",
    green: "rgb(22, 163, 74)",
    yellow: "rgb(202, 138, 4)",
    blue: "rgb(37, 99, 235)",
    magenta: "rgb(192, 38, 211)",
    cyan: "rgb(8, 145, 178)",
    white: "rgb(203, 213, 225)",
    brightBlack: "rgb(100, 116, 139)",
    brightRed: "rgb(239, 68, 68)",
    brightGreen: "rgb(34, 197, 94)",
    brightYellow: "rgb(234, 179, 8)",
    brightBlue: "rgb(59, 130, 246)",
    brightMagenta: "rgb(217, 70, 239)",
    brightCyan: "rgb(6, 182, 212)",
    brightWhite: "rgb(15, 23, 42)",
  };
}

export function generateTheme(
  input: Partial<CustomThemeSettings> | CustomThemeSettings,
  options?: { systemDark?: boolean },
): GeneratedTheme {
  const theme = normalizeThemeSettings(input);
  const resolvedMode = resolveThemeMode(theme, options?.systemDark ?? false);
  const isDark = resolvedMode === "dark";
  const hue = theme.hue;
  const saturation = theme.saturation;
  const neutralSaturation = Math.max(4, Math.round(saturation * (isDark ? 0.18 : 0.16)));
  const softSaturation = Math.max(6, Math.round(saturation * (isDark ? 0.26 : 0.22)));
  const primarySaturation = 100;
  const accentSaturation = Math.max(18, Math.round(saturation * (isDark ? 0.44 : 0.52)));
  const primaryGlowSaturation = clamp(Math.max(58, primarySaturation), 0, 100);
  const primaryGlowLight = isDark ? 40 : 44;
  const primaryGlowDeepLight = isDark ? 18 : 28;

  const cssVariables = isDark
    ? {
        "--background": hsl(hue, neutralSaturation, 8),
        "--app-chrome-background": hsl(hue, neutralSaturation, 8),
        "--foreground": hsl(hue, 8, 93),
        "--card": hsl(hue, softSaturation, 11),
        "--card-foreground": hsl(hue, 8, 93),
        "--popover": hsl(hue, softSaturation, 12),
        "--popover-foreground": hsl(hue, 8, 93),
        "--primary": hsl(hue, primarySaturation, 64),
        "--primary-foreground": hsl(hue, 18, 12),
        "--secondary": hsl(hue, softSaturation, 16),
        "--secondary-foreground": hsl(hue, 8, 90),
        "--muted": hsl(hue, softSaturation, 15),
        "--muted-foreground": hsl(hue, 8, 66),
        "--accent": hsl(hue, accentSaturation, 20),
        "--accent-foreground": hsl(hue, 12, 92),
        "--destructive": hsl(5, 72, 58),
        "--border": hsl(hue, 10, 22),
        "--input": hsl(hue, 10, 24),
        "--ring": hsl(hue, Math.max(42, saturation), 68),
        "--destructive-foreground": hsl(5, 88, 82),
        "--info": hsl((hue + 10) % 360, Math.max(36, saturation), 64),
        "--info-foreground": hsl((hue + 10) % 360, 92, 88),
        "--success": hsl(146, 42, 50),
        "--success-foreground": hsl(146, 72, 88),
        "--warning": hsl(43, 82, 56),
        "--warning-foreground": hsl(43, 95, 18),
        "--diff-surface-bg": "rgb(18, 23, 31)",
        "--diff-surface-elevated-bg": "rgb(22, 28, 37)",
        "--diff-surface-context-bg": "rgb(19, 24, 33)",
        "--diff-surface-hover-bg": "rgb(25, 32, 42)",
        "--diff-surface-separator-bg": "rgb(23, 29, 38)",
        "--diff-surface-buffer-bg": "rgb(16, 21, 29)",
        "--diff-surface-border": "rgba(255, 255, 255, 0.08)",
        "--diff-surface-foreground": "rgb(228, 232, 240)",
        "--diff-surface-title-hover": "rgb(148, 163, 184)",
        "--diff-surface-addition-bg": "rgba(34, 197, 94, 0.12)",
        "--diff-surface-addition-number-bg": "rgba(34, 197, 94, 0.18)",
        "--diff-surface-addition-hover-bg": "rgba(34, 197, 94, 0.22)",
        "--diff-surface-addition-emphasis-bg": "rgba(34, 197, 94, 0.28)",
        "--diff-surface-deletion-bg": "rgba(239, 68, 68, 0.12)",
        "--diff-surface-deletion-number-bg": "rgba(239, 68, 68, 0.18)",
        "--diff-surface-deletion-hover-bg": "rgba(239, 68, 68, 0.22)",
        "--diff-surface-deletion-emphasis-bg": "rgba(239, 68, 68, 0.28)",
        "--composer-surface-overlay-shadow": `inset 0 0 0 1px ${hsla(
          hue,
          primaryGlowSaturation,
          primaryGlowLight,
          0.05,
        )}`,
        "--composer-surface-fill": `linear-gradient(180deg, ${hsla(hue, softSaturation, 14, 0.9)} 0%, ${hsla(hue, softSaturation, 10, 0.82)} 100%)`,
        "--composer-surface-border": hsla(hue, 8, 92, 0.08),
        "--composer-surface-shadow": `inset 0 1px 2px ${hsla(hue, 18, 96, 0.12)}, inset 0 -14px 60px ${hsla(
          hue,
          primaryGlowSaturation,
          primaryGlowDeepLight,
          0.16,
        )}, inset 0 -4px 10px ${hsla(hue, primaryGlowSaturation, primaryGlowLight, 0.12)}, 0 18px 40px ${hsla(
          hue,
          Math.max(18, Math.round(saturation * 0.42)),
          5,
          0.34,
        )}, 0 4px 16px rgba(0, 0, 0, 0.4)`,
        "--composer-surface-focus-shadow": `inset 0 1px 2px ${hsla(hue, 18, 96, 0.16)}, inset 0 -16px 64px ${hsla(
          hue,
          primaryGlowSaturation,
          primaryGlowDeepLight,
          0.16,
        )}, inset 0 -4px 12px ${hsla(hue, primaryGlowSaturation, primaryGlowLight, 0.15)}, 0 22px 48px ${hsla(
          hue,
          Math.max(24, Math.round(saturation * 0.5)),
          6,
          0.4,
        )}, 0 4px 20px rgba(0, 0, 0, 0.5)`,
        "--composer-banner-background": `linear-gradient(180deg, ${hsla(hue, softSaturation, 16, 0.84)} 0%, ${hsla(
          hue,
          softSaturation,
          12,
          0.74,
        )} 100%)`,
        "--composer-banner-border": hsla(hue, 10, 96, 0.08),
        "--composer-banner-shadow": `inset 0 1px 0 ${hsla(hue, 12, 96, 0.08)}, inset 0 -1px 0 rgba(0, 0, 0, 0.22)`,
        "--composer-footer-separator-background-color": hsla(hue, 8, 90, 0.1),
        "--composer-footer-separator-background-opacity": "100%",
        "--composer-footer-separator-border-color": "rgba(0, 0, 0, 0.88)",
        "--composer-footer-separator-border-opacity": "90%",
      }
    : {
        "--background": hsl(hue, neutralSaturation, 97),
        "--app-chrome-background": hsl(hue, neutralSaturation, 97),
        "--foreground": hsl(hue, 14, 18),
        "--card": hsl(hue, softSaturation, 99),
        "--card-foreground": hsl(hue, 14, 18),
        "--popover": hsl(hue, softSaturation, 100),
        "--popover-foreground": hsl(hue, 14, 18),
        "--primary": hsl(hue, primarySaturation, 49),
        "--primary-foreground": hsl(hue, 18, 99),
        "--secondary": hsl(hue, softSaturation, 91),
        "--secondary-foreground": hsl(hue, 14, 18),
        "--muted": hsl(hue, softSaturation, 93),
        "--muted-foreground": hsl(hue, 10, 42),
        "--accent": hsl(hue, accentSaturation, 87),
        "--accent-foreground": hsl(hue, 18, 22),
        "--destructive": hsl(5, 76, 56),
        "--border": hsl(hue, 12, 82),
        "--input": hsl(hue, 12, 78),
        "--ring": hsl(hue, Math.max(42, saturation), 52),
        "--destructive-foreground": hsl(5, 68, 32),
        "--info": hsl((hue + 10) % 360, Math.max(36, saturation), 50),
        "--info-foreground": hsl((hue + 10) % 360, 72, 24),
        "--success": hsl(146, 44, 42),
        "--success-foreground": hsl(146, 70, 24),
        "--warning": hsl(43, 82, 48),
        "--warning-foreground": hsl(43, 92, 22),
        "--diff-surface-bg": "rgb(248, 250, 252)",
        "--diff-surface-elevated-bg": "rgb(241, 245, 249)",
        "--diff-surface-context-bg": "rgb(244, 247, 250)",
        "--diff-surface-hover-bg": "rgb(236, 241, 246)",
        "--diff-surface-separator-bg": "rgb(239, 244, 248)",
        "--diff-surface-buffer-bg": "rgb(232, 238, 244)",
        "--diff-surface-border": "rgba(15, 23, 42, 0.08)",
        "--diff-surface-foreground": "rgb(15, 23, 42)",
        "--diff-surface-title-hover": "rgb(71, 85, 105)",
        "--diff-surface-addition-bg": "rgba(34, 197, 94, 0.1)",
        "--diff-surface-addition-number-bg": "rgba(34, 197, 94, 0.14)",
        "--diff-surface-addition-hover-bg": "rgba(34, 197, 94, 0.18)",
        "--diff-surface-addition-emphasis-bg": "rgba(34, 197, 94, 0.24)",
        "--diff-surface-deletion-bg": "rgba(239, 68, 68, 0.1)",
        "--diff-surface-deletion-number-bg": "rgba(239, 68, 68, 0.14)",
        "--diff-surface-deletion-hover-bg": "rgba(239, 68, 68, 0.18)",
        "--diff-surface-deletion-emphasis-bg": "rgba(239, 68, 68, 0.24)",
        "--composer-surface-overlay-shadow": `inset 0 0 0 1px ${hsla(
          hue,
          primaryGlowSaturation,
          primaryGlowLight,
          0.08,
        )}`,
        "--composer-surface-fill": `linear-gradient(180deg, ${hsla(hue, softSaturation, 100, 0.96)} 0%, ${hsla(
          hue,
          softSaturation,
          95,
          0.92,
        )} 100%)`,
        "--composer-surface-border": hsla(hue, 14, 12, 0.12),
        "--composer-surface-shadow": `inset 0 1px 0 rgba(255, 255, 255, 0.74), inset 0 -8px 20px ${hsla(
          hue,
          primaryGlowSaturation,
          primaryGlowDeepLight,
          0.06,
        )}, 0 18px 36px ${hsla(hue, Math.max(18, Math.round(saturation * 0.42)), 34, 0.16)}, 0 6px 16px ${hsla(
          hue,
          Math.max(14, Math.round(saturation * 0.28)),
          22,
          0.1,
        )}, 0 2px 4px rgba(0, 0, 0, 0.05)`,
        "--composer-surface-focus-shadow": `inset 0 1px 0 rgba(255, 255, 255, 0.82), inset 0 -10px 24px ${hsla(
          hue,
          primaryGlowSaturation,
          primaryGlowDeepLight,
          0.08,
        )}, 0 22px 42px ${hsla(hue, Math.max(24, Math.round(saturation * 0.5)), 34, 0.2)}, 0 8px 20px ${hsla(
          hue,
          Math.max(18, Math.round(saturation * 0.34)),
          22,
          0.12,
        )}, 0 2px 6px rgba(0, 0, 0, 0.07)`,
        "--composer-banner-background": `linear-gradient(180deg, ${hsla(hue, softSaturation, 100, 0.9)} 0%, ${hsla(
          hue,
          softSaturation,
          96,
          0.82,
        )} 100%)`,
        "--composer-banner-border": hsla(hue, 14, 12, 0.1),
        "--composer-banner-shadow":
          "inset 0 1px 0 rgba(255, 255, 255, 0.88), inset 0 -1px 0 rgba(0, 0, 0, 0.02)",
        "--composer-footer-separator-background-color": hsl(hue, softSaturation, 99),
        "--composer-footer-separator-background-opacity": "100%",
        "--composer-footer-separator-border-color": hsla(hue, 14, 12, 0.12),
        "--composer-footer-separator-border-opacity": "100%",
      };

  return {
    theme,
    resolvedMode,
    chromeColor: cssVariables["--app-chrome-background"],
    foregroundColor: cssVariables["--foreground"],
    monacoTheme: isDark ? "vs-dark" : "vs",
    diffThemeFamily: resolvedMode,
    desktopTheme: theme.mode === "system" ? "system" : resolvedMode,
    iconTheme: resolvedMode,
    terminalPalette: buildThemeTerminalPalette(resolvedMode),
    cssVariables: {
      ...cssVariables,
      "--app-theme-hue": String(hue),
      "--app-theme-saturation": String(saturation),
    },
  };
}

function isPersistedThemeDocument(value: unknown): value is PersistedThemeDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    "mode" in value &&
    "hue" in value &&
    "saturation" in value
  );
}

function parseStoredThemeValue(raw: string | null): CustomThemeSettings {
  if (!raw) {
    return DEFAULT_CUSTOM_THEME_SETTINGS;
  }
  if (raw === "system") {
    return DEFAULT_CUSTOM_THEME_SETTINGS;
  }
  if (LEGACY_THEME_PREFERENCES.has(raw)) {
    return DEFAULT_CUSTOM_THEME_SETTINGS;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPersistedThemeDocument(parsed)) {
      return DEFAULT_CUSTOM_THEME_SETTINGS;
    }
    return normalizeThemeSettings(parsed);
  } catch {
    return DEFAULT_CUSTOM_THEME_SETTINGS;
  }
}

export function readStoredThemeSettings(storage?: ThemeStorageLike | null): CustomThemeSettings {
  const targetStorage =
    storage ?? (typeof localStorage !== "undefined" ? (localStorage as ThemeStorageLike) : null);
  if (!targetStorage) {
    return DEFAULT_CUSTOM_THEME_SETTINGS;
  }
  return parseStoredThemeValue(targetStorage.getItem(THEME_STORAGE_KEY));
}

export function writeStoredThemeSettings(
  theme: CustomThemeSettings,
  storage?: ThemeStorageLike | null,
): void {
  const targetStorage =
    storage ?? (typeof localStorage !== "undefined" ? (localStorage as ThemeStorageLike) : null);
  if (!targetStorage) {
    return;
  }
  targetStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(toPersistedThemeDocument(theme)));
}

export function resolveDesktopTheme(theme: CustomThemeSettings, systemDark = false): DesktopTheme {
  if (theme.mode === "system") {
    return "system";
  }
  return resolveThemeMode(theme, systemDark);
}

export function resolveTerminalThemePalette(
  theme: CustomThemeSettings,
  systemDark = false,
): ThemeTerminalPalette {
  return generateTheme(theme, { systemDark }).terminalPalette;
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

export function readResolvedThemeModeFromDocument(
  targetDocument?: Pick<Document, "documentElement"> | null,
): ResolvedThemeMode {
  const safeDocument = targetDocument ?? (typeof document !== "undefined" ? document : null);
  const datasetMode = safeDocument?.documentElement.dataset.themeMode;
  if (datasetMode === "light" || datasetMode === "dark") {
    return datasetMode;
  }
  const legacyTheme = safeDocument?.documentElement.dataset.theme;
  if (legacyTheme === "light" || legacyTheme === "dark") {
    return legacyTheme;
  }
  return safeDocument?.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function readThemeSettingsFromDocument(
  targetDocument?: Pick<Document, "documentElement"> | null,
): CustomThemeSettings {
  const safeDocument = targetDocument ?? (typeof document !== "undefined" ? document : null);
  const dataset = safeDocument?.documentElement.dataset;
  const partialTheme: Partial<CustomThemeSettings> = {};
  if (dataset?.themePreferenceMode) {
    partialTheme.mode = normalizeThemeMode(dataset.themePreferenceMode);
  }
  if (dataset?.themeHue) {
    partialTheme.hue = Number(dataset.themeHue);
  }
  if (dataset?.themeSaturation) {
    partialTheme.saturation = Number(dataset.themeSaturation);
  }
  return normalizeThemeSettings(partialTheme);
}

export function applyThemePreferenceToDocument(
  theme: CustomThemeSettings,
  options?: {
    document?: DocumentLike | null;
    systemDark?: boolean;
  },
): GeneratedTheme {
  const generated = generateTheme(theme, { systemDark: options?.systemDark ?? false });
  const safeDocument =
    options?.document ?? (typeof document !== "undefined" ? (document as DocumentLike) : null);
  if (!safeDocument) {
    return generated;
  }

  const root = safeDocument.documentElement;
  const isDark = generated.resolvedMode === "dark";
  root.classList.toggle("dark", isDark);
  root.dataset.theme = "generated";
  root.dataset.themeMode = generated.resolvedMode;
  root.dataset.themePreferenceMode = generated.theme.mode;
  root.dataset.themeHue = String(generated.theme.hue);
  root.dataset.themeSaturation = String(generated.theme.saturation);
  root.style.backgroundColor = generated.chromeColor;

  for (const [name, value] of Object.entries(generated.cssVariables)) {
    root.style.setProperty(name, value);
  }

  if (safeDocument.body) {
    safeDocument.body.style.backgroundColor = generated.chromeColor;
  }

  setDynamicThemeColor(generated.chromeColor, safeDocument);
  return generated;
}
