import {
  type ImportedMobileTheme,
  normalizeMobileThemeColorLiteral,
  type PortableThemeColorOverrides,
} from "./mobileThemeFile";

export const MOBILE_APPEARANCE_OPTIONS = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;
export type MobileAppearanceMode = (typeof MOBILE_APPEARANCE_OPTIONS)[number]["id"];
export type MobileThemeAppearance = Exclude<MobileAppearanceMode, "system">;

export const MOBILE_THEME_OPTIONS = [
  { id: "t3-code", label: "T3 Code" },
  { id: "t3-chat", label: "T3 Chat" },
  { id: "grove", label: "Grove" },
  { id: "ocean", label: "Ocean" },
  { id: "ember", label: "Ember" },
  { id: "iris", label: "Iris" },
] as const;

export type MobileBuiltInThemeId = (typeof MOBILE_THEME_OPTIONS)[number]["id"];
export type MobileThemeId = string;

export const DEFAULT_MOBILE_APPEARANCE_MODE: MobileAppearanceMode = "system";
export const DEFAULT_MOBILE_THEME_ID: MobileBuiltInThemeId = "t3-code";

export interface MobileThemePreferences {
  readonly appearanceMode: MobileAppearanceMode;
  readonly themeId: MobileThemeId;
}

export interface MobileCoreThemeColors {
  readonly canvas: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly surfaceOverlay: string;
  readonly text: string;
  readonly textMuted: string;
  readonly border: string;
  readonly input: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly secondary: string;
  readonly secondaryForeground: string;
  readonly muted: string;
  readonly mutedForeground: string;
  readonly placeholder: string;
  readonly error: string;
  readonly errorForeground: string;
  readonly errorSurface: string;
  readonly messageSurface: string;
  readonly messageForeground: string;
  readonly codeBackground: string;
  readonly codeForeground: string;
  readonly sidebar: string;
  readonly sidebarForeground: string;
  readonly sidebarMutedForeground: string;
  readonly sidebarControlSurface: string;
}

export interface MobileNativeSurfaceColors {
  readonly terminalBackground: string;
  readonly terminalForeground: string;
  readonly terminalCursor: string;
  readonly sheetBackground: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  readonly border: string;
  readonly accent: string;
}

export interface MobileThemePickerOption {
  readonly id: string;
  readonly label: string;
  readonly imported: boolean;
  readonly light: MobileCoreThemeColors;
  readonly dark: MobileCoreThemeColors;
}

type MobileThemeVariants = Readonly<
  Record<MobileThemeAppearance, Readonly<Partial<MobileCoreThemeColors>>>
>;

const T3_CODE_COLORS: Readonly<Record<MobileThemeAppearance, MobileCoreThemeColors>> = {
  light: {
    canvas: "#f2f2f7",
    surface: "#ffffff",
    surfaceRaised: "#f5f5f5",
    surfaceOverlay: "#ffffff",
    text: "#262626",
    textMuted: "#737373",
    border: "rgba(0, 0, 0, 0.08)",
    input: "rgba(0, 0, 0, 0.1)",
    accent: "#262626",
    accentForeground: "#ffffff",
    secondary: "#ffffff",
    secondaryForeground: "#262626",
    muted: "rgba(0, 0, 0, 0.04)",
    mutedForeground: "#525252",
    placeholder: "#a3a3a3",
    error: "rgba(239, 68, 68, 0.12)",
    errorForeground: "#dc2626",
    errorSurface: "#fef2f2",
    messageSurface: "#007aff",
    messageForeground: "#ffffff",
    codeBackground: "rgba(0, 0, 0, 0.04)",
    codeForeground: "#262626",
    sidebar: "#ffffff",
    sidebarForeground: "#262626",
    sidebarMutedForeground: "#525252",
    sidebarControlSurface: "rgba(118, 118, 128, 0.12)",
  },
  dark: {
    canvas: "#0a0a0a",
    surface: "#171717",
    surfaceRaised: "#1c1c1c",
    surfaceOverlay: "#171717",
    text: "#f5f5f5",
    textMuted: "#8e8e93",
    border: "rgba(255, 255, 255, 0.06)",
    input: "rgba(255, 255, 255, 0.08)",
    accent: "#f5f5f5",
    accentForeground: "#0a0a0a",
    secondary: "rgba(255, 255, 255, 0.04)",
    secondaryForeground: "#f5f5f5",
    muted: "rgba(255, 255, 255, 0.04)",
    mutedForeground: "#a3a3a3",
    placeholder: "#8e8e93",
    error: "rgba(248, 113, 113, 0.18)",
    errorForeground: "#fca5a5",
    errorSurface: "rgba(239, 68, 68, 0.14)",
    messageSurface: "#0a84ff",
    messageForeground: "#ffffff",
    codeBackground: "rgba(255, 255, 255, 0.06)",
    codeForeground: "#e5e5e5",
    sidebar: "#0e0e0e",
    sidebarForeground: "#f5f5f5",
    sidebarMutedForeground: "#a3a3a3",
    sidebarControlSurface: "rgba(118, 118, 128, 0.24)",
  },
};

function normalizeMobileThemeColors(colors: MobileCoreThemeColors): MobileCoreThemeColors {
  return Object.fromEntries(
    Object.entries(colors).map(([role, color]) => {
      const normalized = normalizeMobileThemeColorLiteral(color);
      if (!normalized) throw new Error(`Invalid T3 Code fallback color for "${role}": ${color}`);
      return [role, normalized];
    }),
  ) as unknown as MobileCoreThemeColors;
}

const NORMALIZED_T3_CODE_COLORS: Readonly<Record<MobileThemeAppearance, MobileCoreThemeColors>> = {
  light: normalizeMobileThemeColors(T3_CODE_COLORS.light),
  dark: normalizeMobileThemeColors(T3_CODE_COLORS.dark),
};

const T3_CHAT_COLORS: MobileThemeVariants = {
  light: {
    canvas: "#fdf7fd",
    surface: "#faf3fb",
    surfaceRaised: "#fdfafd",
    surfaceOverlay: "#ffffff",
    text: "#501854",
    textMuted: "#ac1668",
    border: "#eee1ed",
    input: "#e7c1dc",
    accent: "#db2777",
    accentForeground: "#ffffff",
    secondary: "#f1c4e6",
    secondaryForeground: "#77347c",
    muted: "#eaa7cb",
    mutedForeground: "#8d1255",
    placeholder: "#8b5f90",
    error: "#f7086c",
    errorForeground: "#9d174d",
    errorSurface: "#fde4f1",
    messageSurface: "#f7def2",
    messageForeground: "#492c61",
    codeBackground: "#f5ecf9",
    codeForeground: "#673c8b",
    sidebar: "#f2e1f4",
    sidebarForeground: "#454554",
    sidebarMutedForeground: "#ac1668",
    sidebarControlSurface: "#f8f8f7",
  },
  dark: {
    canvas: "#1f1a24",
    surface: "#29232d",
    surfaceRaised: "#2c2631",
    surfaceOverlay: "#100a0e",
    text: "#f9f8fb",
    textMuted: "#e7d0dd",
    border: "#27242c",
    input: "#302029",
    accent: "#a3004c",
    accentForeground: "#fbd0e8",
    secondary: "#362d3d",
    secondaryForeground: "#d4c7e1",
    muted: "#423a45",
    mutedForeground: "#e7d0dd",
    placeholder: "#968d9f",
    error: "#9d174d",
    errorForeground: "#fbd0e8",
    errorSurface: "#331a2b",
    messageSurface: "#2b2431",
    messageForeground: "#f2ebfa",
    codeBackground: "#1f1a24",
    codeForeground: "#d8c3ef",
    sidebar: "#171018",
    sidebarForeground: "#f4f4f5",
    sidebarMutedForeground: "#e7d0dd",
    sidebarControlSurface: "#261922",
  },
};

const MANAGED_LIGHT_COLORS = {
  text: "#241523",
  accentForeground: "#fffaff",
  secondaryForeground: "#241523",
  error: "#fb2c36",
  errorForeground: "#c10007",
  messageForeground: "#241523",
  codeForeground: "#241523",
  sidebarForeground: "#241523",
} as const;

const MANAGED_DARK_COLORS = {
  text: "#fffaff",
  accentForeground: "#241523",
  secondaryForeground: "#fffaff",
  error: "#fb414a",
  errorForeground: "#ff6467",
  messageForeground: "#fffaff",
  codeForeground: "#fffaff",
  sidebarForeground: "#fffaff",
} as const;

function managedTheme(
  light: Readonly<Partial<MobileCoreThemeColors>>,
  dark: Readonly<Partial<MobileCoreThemeColors>>,
): MobileThemeVariants {
  return {
    light: { ...MANAGED_LIGHT_COLORS, ...light },
    dark: { ...MANAGED_DARK_COLORS, ...dark },
  };
}

const THEME_VARIANTS: Readonly<
  Record<Exclude<MobileBuiltInThemeId, "t3-code">, MobileThemeVariants>
> = {
  "t3-chat": T3_CHAT_COLORS,
  grove: managedTheme(
    {
      canvas: "#f3f7f4",
      surface: "#f3f7f4",
      surfaceRaised: "#ecefed",
      surfaceOverlay: "#e7e9e8",
      textMuted: "#746c73",
      border: "#cbd5d1",
      input: "#becbc5",
      accent: "#1b7d50",
      secondary: "#e2ede7",
      muted: "#e6f0ea",
      mutedForeground: "#6e696f",
      placeholder: "#716971",
      errorSurface: "#f4e7e5",
      messageSurface: "#cce1d7",
      codeBackground: "#eef1ef",
      sidebar: "#e2ede7",
      sidebarMutedForeground: "#6b666c",
      sidebarControlSurface: "#d3dcd8",
    },
    {
      canvas: "#1b2821",
      surface: "#1b2821",
      surfaceRaised: "#36413c",
      surfaceOverlay: "#444d49",
      textMuted: "#919595",
      border: "#415f4f",
      input: "#4f725f",
      accent: "#69d69a",
      secondary: "#2a4b39",
      muted: "#253e31",
      mutedForeground: "#9da5a2",
      placeholder: "#a9abab",
      errorSurface: "#3f2c28",
      messageSurface: "#37664d",
      codeBackground: "#28342e",
      sidebar: "#21362b",
      sidebarMutedForeground: "#9da3a2",
      sidebarControlSurface: "#45554d",
    },
  ),
  ocean: managedTheme(
    {
      canvas: "#f5f7f8",
      surface: "#f5f7f8",
      surfaceRaised: "#edeff1",
      surfaceOverlay: "#e8e9eb",
      textMuted: "#746c75",
      border: "#cdd4dc",
      input: "#c0c9d4",
      accent: "#2672af",
      secondary: "#e4ecf2",
      muted: "#e8eff4",
      mutedForeground: "#6f6873",
      placeholder: "#716972",
      errorSurface: "#f5e6e9",
      messageSurface: "#d0dfeb",
      codeBackground: "#f0f1f3",
      sidebar: "#e4ecf2",
      sidebarMutedForeground: "#6c6570",
      sidebarControlSurface: "#d5dbe2",
    },
    {
      canvas: "#17212b",
      surface: "#17212b",
      surfaceRaised: "#333b45",
      surfaceOverlay: "#414851",
      textMuted: "#8d8f97",
      border: "#405567",
      input: "#4f677b",
      accent: "#70b9ee",
      secondary: "#293f52",
      muted: "#233544",
      mutedForeground: "#969ca6",
      placeholder: "#a4a4ac",
      errorSurface: "#3c2630",
      messageSurface: "#375871",
      codeBackground: "#252e38",
      sidebar: "#1e2d3b",
      sidebarMutedForeground: "#989ca5",
      sidebarControlSurface: "#424e5a",
    },
  ),
  ember: managedTheme(
    {
      canvas: "#f9f7f5",
      surface: "#f9f7f5",
      surfaceRaised: "#f1efee",
      surfaceOverlay: "#ece9e9",
      textMuted: "#766c74",
      border: "#ddd2ce",
      input: "#d4c6c1",
      accent: "#ae552a",
      secondary: "#f3eae5",
      muted: "#f4ede9",
      mutedForeground: "#74686f",
      placeholder: "#736971",
      errorSurface: "#f9e7e6",
      messageSurface: "#ebdad1",
      codeBackground: "#f3f1f0",
      sidebar: "#f3eae5",
      sidebarMutedForeground: "#71646b",
      sidebarControlSurface: "#e2d9d6",
    },
    {
      canvas: "#291e1a",
      surface: "#291e1a",
      surfaceRaised: "#433835",
      surfaceOverlay: "#4f4543",
      textMuted: "#968e8f",
      border: "#664c3f",
      input: "#7a5d4d",
      accent: "#f09a64",
      secondary: "#513728",
      muted: "#432e23",
      mutedForeground: "#a59996",
      placeholder: "#aba3a5",
      errorSurface: "#4a2321",
      messageSurface: "#704b34",
      codeBackground: "#362b27",
      sidebar: "#39281f",
      sidebarMutedForeground: "#a49998",
      sidebarControlSurface: "#584943",
    },
  ),
  iris: managedTheme(
    {
      canvas: "#f8f7f9",
      surface: "#f8f7f9",
      surfaceRaised: "#f0eff2",
      surfaceOverlay: "#ebe9ed",
      textMuted: "#766c76",
      border: "#d6d1de",
      input: "#ccc5d6",
      accent: "#7253b9",
      secondary: "#edeaf4",
      muted: "#f0edf6",
      mutedForeground: "#726874",
      placeholder: "#736973",
      errorSurface: "#f8e6ea",
      messageSurface: "#e0d9ee",
      codeBackground: "#f2f1f4",
      sidebar: "#edeaf4",
      sidebarMutedForeground: "#6f6471",
      sidebarControlSurface: "#ddd9e3",
    },
    {
      canvas: "#1d1929",
      surface: "#1d1929",
      surfaceRaised: "#383443",
      surfaceOverlay: "#454250",
      textMuted: "#8e8a95",
      border: "#4d4366",
      input: "#5d527b",
      accent: "#9d7df2",
      secondary: "#362d51",
      muted: "#2d2643",
      mutedForeground: "#9690a1",
      placeholder: "#a29ea8",
      errorSurface: "#40202e",
      messageSurface: "#4b3d72",
      codeBackground: "#2a2736",
      sidebar: "#272139",
      sidebarMutedForeground: "#9792a0",
      sidebarControlSurface: "#494459",
    },
  ),
};

export function isMobileAppearanceMode(value: unknown): value is MobileAppearanceMode {
  return MOBILE_APPEARANCE_OPTIONS.some((option) => option.id === value);
}

export function isMobileBuiltInThemeId(value: unknown): value is MobileBuiltInThemeId {
  return MOBILE_THEME_OPTIONS.some((theme) => theme.id === value);
}

export function isMobileThemeId(
  value: unknown,
  importedThemes: ReadonlyArray<ImportedMobileTheme> = [],
): value is MobileThemeId {
  return (
    isMobileBuiltInThemeId(value) ||
    (typeof value === "string" && importedThemes.some((theme) => theme.id === value))
  );
}

export function resolveMobileThemePreferences(
  stored: { readonly appearanceMode?: unknown; readonly themeId?: unknown } | null | undefined,
  importedThemes: ReadonlyArray<ImportedMobileTheme> = [],
): MobileThemePreferences {
  return {
    appearanceMode: isMobileAppearanceMode(stored?.appearanceMode)
      ? stored.appearanceMode
      : DEFAULT_MOBILE_APPEARANCE_MODE,
    themeId: isMobileThemeId(stored?.themeId, importedThemes)
      ? stored.themeId
      : DEFAULT_MOBILE_THEME_ID,
  };
}

export function removeImportedMobileTheme(
  importedThemes: ReadonlyArray<ImportedMobileTheme>,
  removedThemeId: string,
  selectedThemeId: MobileThemeId,
): Readonly<{
  importedThemes: ReadonlyArray<ImportedMobileTheme>;
  themeId?: MobileThemeId;
}> | null {
  const next = importedThemes.filter((theme) => theme.id !== removedThemeId);
  if (next.length === importedThemes.length) return null;
  return {
    importedThemes: next,
    ...(selectedThemeId === removedThemeId ? { themeId: DEFAULT_MOBILE_THEME_ID } : {}),
  };
}

export function resolveColorSchemeOverride(
  mode: MobileAppearanceMode,
): MobileThemeAppearance | null {
  return mode === "system" ? null : mode;
}

export function resolveMobileThemeColors(
  themeId: string,
  appearance: MobileThemeAppearance,
  importedThemes: ReadonlyArray<ImportedMobileTheme> = [],
): MobileCoreThemeColors {
  const fallback = T3_CODE_COLORS[appearance];
  if (themeId === "t3-code") return fallback;
  if (isMobileBuiltInThemeId(themeId)) {
    const alternateThemeId = themeId as Exclude<MobileBuiltInThemeId, "t3-code">;
    return { ...fallback, ...THEME_VARIANTS[alternateThemeId][appearance] };
  }

  const theme = importedThemes.find((candidate) => candidate.id === themeId);
  const overrides = theme ? getImportedThemeOverrides(theme, appearance) : null;
  return overrides
    ? { ...NORMALIZED_T3_CODE_COLORS[appearance], ...pickMobileCoreThemeColors(overrides) }
    : fallback;
}

const BUILT_IN_MOBILE_THEME_PICKER_OPTIONS: ReadonlyArray<MobileThemePickerOption> =
  MOBILE_THEME_OPTIONS.map((theme) => ({
    ...theme,
    imported: false,
    light: resolveMobileThemeColors(theme.id, "light"),
    dark: resolveMobileThemeColors(theme.id, "dark"),
  }));

export function resolveMobileThemePickerOptions(
  importedThemes: ReadonlyArray<ImportedMobileTheme>,
): ReadonlyArray<MobileThemePickerOption> {
  return [
    ...BUILT_IN_MOBILE_THEME_PICKER_OPTIONS,
    ...importedThemes.map((theme) => ({
      id: theme.id,
      label: theme.name,
      imported: true,
      light: resolveMobileThemeColors(theme.id, "light", importedThemes),
      dark: resolveMobileThemeColors(theme.id, "dark", importedThemes),
    })),
  ];
}

function getImportedThemeOverrides(
  theme: ImportedMobileTheme,
  appearance: MobileThemeAppearance,
): PortableThemeColorOverrides | null {
  return appearance === theme.appearance ? theme.colors : (theme.variants?.[appearance] ?? null);
}

function pickMobileCoreThemeColors(
  colors: PortableThemeColorOverrides,
): Readonly<Partial<MobileCoreThemeColors>> {
  const overrides: { -readonly [Role in keyof MobileCoreThemeColors]?: string } = {};
  for (const role of Object.keys(T3_CODE_COLORS.light) as Array<keyof MobileCoreThemeColors>) {
    const color = colors[role];
    if (color) overrides[role] = color;
  }
  return overrides;
}

export function resolveMobileNativeSurfaceColors(
  themeId: string,
  appearance: MobileThemeAppearance,
  importedThemes: ReadonlyArray<ImportedMobileTheme> = [],
): MobileNativeSurfaceColors | null {
  if (themeId === "t3-code") return null;
  const builtIn = isMobileBuiltInThemeId(themeId);
  const importedTheme = importedThemes.find((candidate) => candidate.id === themeId);
  if (!builtIn && !importedTheme) return null;

  const portableColors = importedTheme
    ? getImportedThemeOverrides(importedTheme, appearance)
    : null;
  if (importedTheme && !portableColors) return null;

  const colors = resolveMobileThemeColors(themeId, appearance, importedThemes);
  return {
    terminalBackground: portableColors?.terminalBackground ?? colors.canvas,
    terminalForeground: portableColors?.terminalForeground ?? colors.text,
    terminalCursor: portableColors?.terminalCursor ?? colors.accent,
    sheetBackground: withAlpha(colors.canvas, "fa"),
    foreground: colors.text,
    mutedForeground: colors.textMuted,
    border: colors.border,
    accent: colors.accent,
  };
}

/** Keeps the shipped T3 Code sheet bytes while resolving selected-theme surfaces. */
export function resolveMobileFormSheetBackground(
  themeId: string,
  appearance: MobileThemeAppearance,
  importedThemes: ReadonlyArray<ImportedMobileTheme> = [],
): string {
  const nativeSurfaceColors = resolveMobileNativeSurfaceColors(themeId, appearance, importedThemes);
  return nativeSurfaceColors?.sheetBackground ?? (appearance === "dark" ? "#0e0e0e" : "#f2f2f7");
}

export function withAlpha(color: string, alpha: string): string {
  if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color) || !/^[\da-f]{2}$/i.test(alpha)) {
    throw new Error(`Expected a 6- or 8-digit hex color and 2-digit alpha, received ${color}`);
  }
  return `${color.slice(0, 7)}${alpha}`;
}

const T3_CODE_MARKDOWN_VARIABLES = {
  light: {
    "--color-md-body": "#111111",
    "--color-md-strong": "#000000",
    "--color-md-link": "#2563eb",
    "--color-md-blockquote-border": "rgba(0, 0, 0, 0.08)",
    "--color-md-blockquote-bg": "rgba(0, 0, 0, 0.02)",
    "--color-md-code-bg": "rgba(0, 0, 0, 0.04)",
    "--color-md-code-text": "#262626",
    "--color-md-inline-code-text": "#5f6368",
    "--color-md-user-code-bg": "rgba(255, 255, 255, 0.22)",
    "--color-md-user-code-text": "#ffffff",
    "--color-md-user-inline-code-text": "rgba(255, 255, 255, 0.82)",
    "--color-md-user-fence-bg": "rgba(0, 0, 0, 0.16)",
    "--color-md-user-fence-text": "#ffffff",
    "--color-md-hr": "rgba(0, 0, 0, 0.08)",
    "--color-user-bubble": "#007aff",
    "--color-user-bubble-foreground": "#ffffff",
    "--color-user-bubble-foreground-muted": "rgba(255, 255, 255, 0.78)",
  },
  dark: {
    "--color-md-body": "#e5e5e5",
    "--color-md-strong": "#f5f5f5",
    "--color-md-link": "#60a5fa",
    "--color-md-blockquote-border": "rgba(255, 255, 255, 0.1)",
    "--color-md-blockquote-bg": "rgba(255, 255, 255, 0.03)",
    "--color-md-code-bg": "rgba(255, 255, 255, 0.06)",
    "--color-md-code-text": "#e5e5e5",
    "--color-md-inline-code-text": "#b8bcc2",
    "--color-md-user-code-bg": "rgba(255, 255, 255, 0.18)",
    "--color-md-user-code-text": "#ffffff",
    "--color-md-user-inline-code-text": "rgba(255, 255, 255, 0.82)",
    "--color-md-user-fence-bg": "rgba(0, 0, 0, 0.28)",
    "--color-md-user-fence-text": "#ffffff",
    "--color-md-hr": "rgba(255, 255, 255, 0.08)",
    "--color-user-bubble": "#0a84ff",
    "--color-user-bubble-foreground": "#ffffff",
    "--color-user-bubble-foreground-muted": "rgba(255, 255, 255, 0.78)",
  },
} as const;

const T3_CODE_VARIABLES = {
  light: {
    "--color-screen": "#f2f2f7",
    "--color-sheet": "rgba(242, 242, 247, 0.98)",
    "--color-card": "#ffffff",
    "--color-card-alt": "#f5f5f5",
    "--color-card-translucent": "rgba(255, 255, 255, 0.8)",
    "--color-foreground": "#262626",
    "--color-foreground-secondary": "#525252",
    "--color-foreground-muted": "#737373",
    "--color-foreground-tertiary": "#8e8e93",
    "--color-border": "rgba(0, 0, 0, 0.08)",
    "--color-border-subtle": "rgba(0, 0, 0, 0.06)",
    "--color-separator": "rgba(0, 0, 0, 0.04)",
    "--color-subtle": "rgba(0, 0, 0, 0.04)",
    "--color-subtle-strong": "rgba(0, 0, 0, 0.08)",
    "--color-inline-skill-background": "rgba(217, 70, 239, 0.12)",
    "--color-inline-skill-border": "rgba(217, 70, 239, 0.25)",
    "--color-inline-skill-foreground": "#a21caf",
    "--color-primary": "#262626",
    "--color-primary-foreground": "#ffffff",
    "--color-primary-shadow": "rgba(0, 0, 0, 0.18)",
    "--color-secondary": "#ffffff",
    "--color-secondary-foreground": "#262626",
    "--color-secondary-border": "rgba(0, 0, 0, 0.08)",
    "--color-switch-active": "#34c759",
    "--color-danger": "#fef2f2",
    "--color-danger-border": "rgba(239, 68, 68, 0.12)",
    "--color-danger-foreground": "#dc2626",
    "--color-input": "#ffffff",
    "--color-input-border": "rgba(0, 0, 0, 0.1)",
    "--color-sidebar-search": "rgba(118, 118, 128, 0.12)",
    "--color-placeholder": "#a3a3a3",
    "--color-icon": "#262626",
    "--color-icon-muted": "#525252",
    "--color-icon-subtle": "#a3a3a3",
    "--color-header": "rgba(255, 255, 255, 0.97)",
    "--color-header-border": "rgba(0, 0, 0, 0.06)",
    "--color-glass-surface": "rgba(255, 255, 255, 0.72)",
    "--color-glass-tint": "rgba(255, 255, 255, 0.18)",
    "--color-status-bar": "#f2f2f7",
    ...T3_CODE_MARKDOWN_VARIABLES.light,
    "--color-backdrop": "rgba(0, 0, 0, 0.22)",
    "--color-drawer": "rgba(255, 255, 255, 0.99)",
    "--color-drawer-shadow": "rgba(0, 0, 0, 0.12)",
    "--color-dot-separator": "rgba(0, 0, 0, 0.2)",
    "--color-wordmark": "#262626",
    "--color-chevron": "rgba(0, 0, 0, 0.2)",
  },
  dark: {
    "--color-screen": "#0a0a0a",
    "--color-sheet": "rgba(14, 14, 14, 0.98)",
    "--color-card": "#171717",
    "--color-card-alt": "#1c1c1c",
    "--color-card-translucent": "rgba(17, 17, 17, 0.8)",
    "--color-foreground": "#f5f5f5",
    "--color-foreground-secondary": "#a3a3a3",
    "--color-foreground-muted": "#8e8e93",
    "--color-foreground-tertiary": "#636366",
    "--color-border": "rgba(255, 255, 255, 0.06)",
    "--color-border-subtle": "rgba(255, 255, 255, 0.04)",
    "--color-separator": "rgba(255, 255, 255, 0.03)",
    "--color-subtle": "rgba(255, 255, 255, 0.04)",
    "--color-subtle-strong": "rgba(255, 255, 255, 0.08)",
    "--color-inline-skill-background": "rgba(217, 70, 239, 0.12)",
    "--color-inline-skill-border": "rgba(217, 70, 239, 0.25)",
    "--color-inline-skill-foreground": "#f0abfc",
    "--color-primary": "#f5f5f5",
    "--color-primary-foreground": "#0a0a0a",
    "--color-primary-shadow": "rgba(0, 0, 0, 0.22)",
    "--color-secondary": "rgba(255, 255, 255, 0.04)",
    "--color-secondary-foreground": "#f5f5f5",
    "--color-secondary-border": "rgba(255, 255, 255, 0.06)",
    "--color-switch-active": "#30d158",
    "--color-danger": "rgba(239, 68, 68, 0.14)",
    "--color-danger-border": "rgba(248, 113, 113, 0.18)",
    "--color-danger-foreground": "#fca5a5",
    "--color-input": "#141414",
    "--color-input-border": "rgba(255, 255, 255, 0.08)",
    "--color-sidebar-search": "rgba(118, 118, 128, 0.24)",
    "--color-placeholder": "#8e8e93",
    "--color-icon": "#f5f5f5",
    "--color-icon-muted": "#a3a3a3",
    "--color-icon-subtle": "#8e8e93",
    "--color-header": "rgba(10, 10, 10, 0.97)",
    "--color-header-border": "rgba(255, 255, 255, 0.06)",
    "--color-glass-surface": "rgba(23, 23, 23, 0.78)",
    "--color-glass-tint": "rgba(23, 23, 23, 0.24)",
    "--color-status-bar": "#0a0a0a",
    ...T3_CODE_MARKDOWN_VARIABLES.dark,
    "--color-backdrop": "rgba(0, 0, 0, 0.48)",
    "--color-drawer": "rgba(14, 14, 14, 0.99)",
    "--color-drawer-shadow": "rgba(0, 0, 0, 0.32)",
    "--color-dot-separator": "rgba(255, 255, 255, 0.2)",
    "--color-wordmark": "#f5f5f5",
    "--color-chevron": "rgba(255, 255, 255, 0.2)",
  },
} as const;

/** Maps web theme roles onto the smaller mobile token surface. */
export function resolveMobileThemeVariables(
  themeId: string,
  appearance: MobileThemeAppearance,
  importedThemes: ReadonlyArray<ImportedMobileTheme> = [],
): Readonly<Record<string, string>> {
  if (!isMobileThemeId(themeId, importedThemes) || themeId === "t3-code") {
    return T3_CODE_VARIABLES[appearance];
  }

  const importedTheme = importedThemes.find((candidate) => candidate.id === themeId);
  if (importedTheme && !getImportedThemeOverrides(importedTheme, appearance)) {
    return T3_CODE_VARIABLES[appearance];
  }

  const colors = resolveMobileThemeColors(themeId, appearance, importedThemes);
  const dark = appearance === "dark";
  const markdownVariables = {
    "--color-md-body": colors.text,
    "--color-md-strong": colors.text,
    "--color-md-link": colors.accent,
    "--color-md-blockquote-border": colors.border,
    "--color-md-blockquote-bg": colors.muted,
    "--color-md-code-bg": colors.codeBackground,
    "--color-md-code-text": colors.codeForeground,
    "--color-md-inline-code-text": colors.textMuted,
    "--color-md-user-code-bg": withAlpha(colors.messageForeground, "38"),
    "--color-md-user-code-text": colors.messageForeground,
    "--color-md-user-inline-code-text": withAlpha(colors.messageForeground, "d1"),
    "--color-md-user-fence-bg": withAlpha(colors.text, dark ? "47" : "29"),
    "--color-md-user-fence-text": colors.messageForeground,
    "--color-md-hr": colors.border,
    "--color-user-bubble": colors.messageSurface,
    "--color-user-bubble-foreground": colors.messageForeground,
    "--color-user-bubble-foreground-muted": withAlpha(colors.messageForeground, "c7"),
  };

  return {
    "--color-screen": colors.canvas,
    "--color-sheet": withAlpha(colors.canvas, "fa"),
    "--color-card": colors.surface,
    "--color-card-alt": colors.surfaceRaised,
    "--color-card-translucent": withAlpha(colors.surface, "cc"),
    "--color-foreground": colors.text,
    "--color-foreground-secondary": colors.mutedForeground,
    "--color-foreground-muted": colors.textMuted,
    "--color-foreground-tertiary": colors.placeholder,
    "--color-border": colors.border,
    "--color-border-subtle": withAlpha(colors.border, dark ? "b3" : "cc"),
    "--color-separator": withAlpha(colors.border, "99"),
    "--color-subtle": colors.muted,
    "--color-subtle-strong": colors.secondary,
    "--color-inline-skill-background": withAlpha(colors.accent, "1f"),
    "--color-inline-skill-border": withAlpha(colors.accent, "40"),
    "--color-inline-skill-foreground": colors.accent,
    "--color-primary": colors.accent,
    "--color-primary-foreground": colors.accentForeground,
    "--color-primary-shadow": withAlpha(colors.text, dark ? "38" : "2e"),
    "--color-secondary": colors.secondary,
    "--color-secondary-foreground": colors.secondaryForeground,
    "--color-secondary-border": colors.border,
    "--color-switch-active": colors.accent,
    "--color-danger": colors.errorSurface,
    "--color-danger-border": colors.error,
    "--color-danger-foreground": colors.errorForeground,
    "--color-input": colors.surface,
    "--color-input-border": colors.input,
    "--color-sidebar-search": colors.sidebarControlSurface,
    "--color-placeholder": colors.placeholder,
    "--color-icon": colors.text,
    "--color-icon-muted": colors.textMuted,
    "--color-icon-subtle": colors.placeholder,
    "--color-header": withAlpha(colors.canvas, "f7"),
    "--color-header-border": colors.border,
    "--color-glass-surface": withAlpha(colors.surface, "c7"),
    "--color-glass-tint": withAlpha(colors.surfaceRaised, "3d"),
    "--color-status-bar": colors.canvas,
    ...markdownVariables,
    "--color-backdrop": dark ? "#0000007a" : "#00000038",
    "--color-drawer": withAlpha(colors.sidebar, "fc"),
    "--color-drawer-shadow": dark ? "#00000052" : "#0000001f",
    "--color-dot-separator": withAlpha(colors.text, "33"),
    "--color-wordmark": colors.text,
    "--color-chevron": withAlpha(colors.text, "33"),
  };
}
