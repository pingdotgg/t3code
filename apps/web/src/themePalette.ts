import * as Schema from "effect/Schema";

import {
  BUILT_IN_THEME_DEFINITIONS,
  EMBER_THEME,
  EMBER_THEME_ID,
  EMBER_THEME_LABEL,
  GROVE_THEME,
  GROVE_THEME_ID,
  GROVE_THEME_LABEL,
  IRIS_THEME,
  IRIS_THEME_ID,
  IRIS_THEME_LABEL,
  OCEAN_THEME,
  OCEAN_THEME_ID,
  OCEAN_THEME_LABEL,
  RESERVED_THEME_IDS,
  T3_CHAT_THEME,
  T3_CHAT_THEME_ID,
  T3_CHAT_THEME_LABEL,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  createManagedThemeColors,
  createVividThemeColors,
  getDefaultThemeColors,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition as getBuiltInThemeDefinition,
  getThemeModes,
  isThemeColor,
} from "@t3tools/themes";

export {
  BUILT_IN_THEME_DEFINITIONS,
  EMBER_THEME,
  EMBER_THEME_ID,
  EMBER_THEME_LABEL,
  GROVE_THEME,
  GROVE_THEME_ID,
  GROVE_THEME_LABEL,
  IRIS_THEME,
  IRIS_THEME_ID,
  IRIS_THEME_LABEL,
  OCEAN_THEME,
  OCEAN_THEME_ID,
  OCEAN_THEME_LABEL,
  T3_CHAT_THEME,
  T3_CHAT_THEME_ID,
  T3_CHAT_THEME_LABEL,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  createManagedThemeColors,
  createVividThemeColors,
  getDefaultThemeColors,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  isThemeColor,
};
export type {
  ThemeAppearance,
  ThemeColorOverrides,
  ThemeColorRole,
  ThemeColors,
  ThemeDefinition,
  ThemeFile,
  ThemePreferenceMode,
  ThemeVariantOverrides,
  ThemeVariants,
} from "@t3tools/themes";
import type {
  ThemeAppearance,
  ThemeColorOverrides,
  ThemeColorRole,
  ThemeColors,
  ThemeDefinition,
  ThemeFile,
  ThemePreferenceMode,
  ThemeVariants,
} from "@t3tools/themes";

export const CUSTOM_THEMES_STORAGE_KEY = "t3code:themes:v1";
export const THEME_FOLLOW_SYSTEM_STORAGE_KEY = "t3code:theme-follow-system";
export const THEME_APPEARANCE_MODE_STORAGE_KEY = "t3code:theme-appearance-mode";
export const THEME_HALVES_STORAGE_KEY = "t3code:theme-halves:v1";

const LEGACY_T3_CHAT_DARK_THEME_ID = "t3-chat-dark";
const LEGACY_RESERVED_THEME_IDS = new Set([
  T3_CHAT_THEME_ID,
  GROVE_THEME_ID,
  OCEAN_THEME_ID,
  EMBER_THEME_ID,
  IRIS_THEME_ID,
  LEGACY_T3_CHAT_DARK_THEME_ID,
  "t3-grove",
  "t3-ocean",
  "t3-ember",
  "t3-iris",
]);

export const ThemePreference = Schema.String;
export type ThemePreference = typeof ThemePreference.Type;

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
const customThemeListeners = new Set<() => void>();
let customThemesSnapshot: ReadonlyArray<ThemeDefinition> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

function parseStoredThemeColors(value: unknown, appearance: ThemeAppearance): ThemeColors | null {
  if (!isRecord(value)) return null;
  const colors: Partial<Record<ThemeColorRole, string>> = {
    ...getDefaultThemeColors(appearance),
  };
  for (const [role, color] of Object.entries(value)) {
    if (THEME_COLOR_ROLE_SET.has(role) && isThemeColor(color)) {
      colors[role as ThemeColorRole] = color;
    }
  }
  return colors as ThemeColors;
}

function parseStoredThemeVariants(
  value: unknown,
  baseAppearance: ThemeAppearance,
): ThemeVariants | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const [appearance, colors] of Object.entries(value)) {
    if (!isThemeAppearance(appearance)) return null;
    if (appearance === baseAppearance) continue;
    const parsedColors = parseStoredThemeColors(colors, appearance);
    if (!parsedColors) return null;
    variants[appearance] = parsedColors;
  }
  return Object.keys(variants).length > 0 ? variants : undefined;
}

function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null;
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null;
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null;
  const colors = parseStoredThemeColors(value.colors, value.appearance);
  if (!colors) return null;
  const variants = parseStoredThemeVariants(value.variants, value.appearance);
  if (value.variants !== undefined && variants === null) return null;
  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors,
    ...(variants ? { variants } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

function readCustomThemesFromStorage(): ReadonlyArray<ThemeDefinition> {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const themes: ThemeDefinition[] = [];
    for (const value of parsed) {
      const theme = parseStoredTheme(value);
      if (theme && !themes.some((existing) => existing.id === theme.id)) themes.push(theme);
    }
    return themes;
  } catch {
    return [];
  }
}

function notifyCustomThemeListeners(): void {
  for (const listener of customThemeListeners) listener();
}

export function invalidateCustomThemes(): void {
  customThemesSnapshot = null;
  notifyCustomThemeListeners();
}

export function getCustomThemes(): ReadonlyArray<ThemeDefinition> {
  if (customThemesSnapshot === null) customThemesSnapshot = readCustomThemesFromStorage();
  return customThemesSnapshot;
}

export function subscribeToCustomThemes(listener: () => void): () => void {
  customThemeListeners.add(listener);
  if (typeof window === "undefined") return () => customThemeListeners.delete(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_THEMES_STORAGE_KEY || event.key === null) invalidateCustomThemes();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    customThemeListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

const LEGACY_THEME_ID_ALIASES: Readonly<Record<string, string>> = {
  [LEGACY_T3_CHAT_DARK_THEME_ID]: T3_CHAT_THEME_ID,
  "t3-grove": GROVE_THEME_ID,
  "t3-ocean": OCEAN_THEME_ID,
  "t3-ember": EMBER_THEME_ID,
  "t3-iris": IRIS_THEME_ID,
};

function normalizeThemeId(themeId: string): string {
  return LEGACY_THEME_ID_ALIASES[themeId] ?? themeId;
}

export function canonicalThemePreference(theme: string): string {
  return theme === LEGACY_T3_CHAT_DARK_THEME_ID ? theme : normalizeThemeId(theme);
}

function themeIdFromPreference(theme: ThemePreference): string {
  return normalizeThemeId(theme);
}

function legacyThemeMode(theme: ThemePreference): ThemeAppearance | null {
  return theme === LEGACY_T3_CHAT_DARK_THEME_ID ? "dark" : null;
}

export function getThemeDefinition(theme: ThemePreference): ThemeDefinition | null {
  const themeId = themeIdFromPreference(theme);
  return getBuiltInThemeDefinition(themeId) ?? getCustomThemes().find((item) => item.id === themeId) ?? null;
}

export function getThemePreferenceMode(theme: ThemePreference): ThemeAppearance | null {
  if (theme === "system") return null;
  if (theme === "light" || theme === "dark") return theme;
  const legacyMode = legacyThemeMode(theme);
  if (legacyMode) return legacyMode;
  return getThemeDefinition(theme)?.appearance ?? null;
}

export function themeIdFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "custom-theme";
}

export class ThemeLibraryStorageError extends Schema.TaggedErrorClass<ThemeLibraryStorageError>()(
  "ThemeLibraryStorageError",
  { storageKey: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to write the theme library to ${this.storageKey}.`;
  }
}

export const isThemeLibraryStorageError = Schema.is(ThemeLibraryStorageError);

function saveCustomThemes(themes: ReadonlyArray<ThemeDefinition>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(themes));
    customThemesSnapshot = themes;
  } catch (cause) {
    throw new ThemeLibraryStorageError({ storageKey: CUSTOM_THEMES_STORAGE_KEY, cause });
  }
  notifyCustomThemeListeners();
}

export function installCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) throw new Error(`The theme id "${theme.id}" is reserved.`);
  if ([...BUILT_IN_THEME_DEFINITIONS, ...getCustomThemes()].some((item) => item.id === theme.id)) {
    throw new Error(`A theme named "${theme.label}" is already installed.`);
  }
  saveCustomThemes([...getCustomThemes(), theme]);
  return theme;
}

export function updateCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) throw new Error(`The theme id "${theme.id}" is reserved.`);
  const themes = getCustomThemes();
  const themeIndex = themes.findIndex((item) => item.id === theme.id);
  if (themeIndex === -1) throw new Error(`The theme "${theme.label}" is not installed.`);
  const nextThemes = [...themes];
  nextThemes[themeIndex] = theme;
  saveCustomThemes(nextThemes);
  return theme;
}

export function removeCustomTheme(themeId: string): void {
  const current = getCustomThemes();
  const nextThemes = current.filter((theme) => theme.id !== themeId);
  if (nextThemes.length === current.length) return;
  saveCustomThemes(nextThemes);
}

function parseThemeColorOverrides(value: unknown): ThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");
  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) throw new Error(`"${role}" is not a supported theme color role.`);
    if (!isThemeColor(color)) throw new Error(`The color for "${role}" must be a hex color such as #8b5cf6.`);
    overrides[role as ThemeColorRole] = color;
  }
  if (Object.keys(overrides).length === 0) throw new Error("Add at least one color role to the theme file.");
  return overrides;
}

export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }
  const name = value.name;
  const appearance = value.appearance;
  const rawColors = value.colors;
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).");
  if (!isThemeAppearance(appearance)) throw new Error('Theme files need an appearance of "light" or "dark".');
  if (!isRecord(rawColors)) throw new Error("Theme files need a colors object.");
  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (!isThemeId(id)) throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  // Parsing also feeds the VS Code importer, which may need to compose a
  // newly ported theme whose human name matches a built-in. The original
  // built-in ids retain their parser guard, while installCustomTheme remains
  // the policy boundary that rejects every reserved id before persistence.
  if (LEGACY_RESERVED_THEME_IDS.has(id)) {
    throw new Error(`The theme id "${id}" is reserved.`);
  }
  const overrides = parseThemeColorOverrides(rawColors);
  const fallback = getDefaultThemeColors(appearance);
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) throw new Error('Theme variants may only be named "light" or "dark".');
      if (variantAppearance === appearance) throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      variants[variantAppearance] = {
        ...getDefaultThemeColors(variantAppearance),
        ...parseThemeColorOverrides(variantColors),
      };
    }
  }
  return {
    id,
    label: name.trim(),
    appearance,
    colors: { ...fallback, ...overrides },
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: theme.id,
    name: theme.label,
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
    ...(theme.managed ? { managed: true } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const APP_THEME_VARIABLES: Readonly<Record<ThemeColorRole, string>> = {
  canvas: "--app-theme-canvas",
  chrome: "--app-theme-chrome",
  toolbar: "--app-theme-toolbar",
  toolbarForeground: "--app-theme-toolbar-foreground",
  toolbarBorder: "--app-theme-toolbar-border",
  toolbarControl: "--app-theme-toolbar-control",
  toolbarControlForeground: "--app-theme-toolbar-control-foreground",
  toolbarControlHover: "--app-theme-toolbar-control-hover",
  surface: "--app-theme-surface",
  surfaceRaised: "--app-theme-surface-raised",
  surfaceOverlay: "--app-theme-surface-overlay",
  text: "--app-theme-text",
  textMuted: "--app-theme-text-muted",
  border: "--app-theme-border",
  input: "--app-theme-input",
  focus: "--app-theme-focus",
  accent: "--app-theme-accent",
  accentForeground: "--app-theme-accent-foreground",
  secondary: "--app-theme-secondary",
  secondaryForeground: "--app-theme-secondary-foreground",
  muted: "--app-theme-muted",
  mutedForeground: "--app-theme-muted-foreground",
  placeholder: "--app-theme-placeholder",
  secondaryLabel: "--app-theme-secondary-label",
  iconMuted: "--app-theme-icon-muted",
  error: "--app-theme-error",
  errorForeground: "--app-theme-error-foreground",
  errorSurface: "--app-theme-error-surface",
  warning: "--app-theme-warning",
  warningForeground: "--app-theme-warning-foreground",
  warningSurface: "--app-theme-warning-surface",
  update: "--app-theme-update",
  updateForeground: "--app-theme-update-foreground",
  updateSurface: "--app-theme-update-surface",
  accentSurface: "--app-theme-accent-surface",
  accentSurfaceForeground: "--app-theme-accent-surface-foreground",
  messageSurface: "--app-theme-message-surface",
  messageForeground: "--app-theme-message-foreground",
  messageAction: "--app-theme-message-action",
  messageActionForeground: "--app-theme-message-action-foreground",
  messageActionHover: "--app-theme-message-action-hover",
  codeBackground: "--app-theme-code-background",
  codeForeground: "--app-theme-code-foreground",
  sidebar: "--app-theme-sidebar",
  sidebarForeground: "--app-theme-sidebar-foreground",
  sidebarMutedForeground: "--app-theme-sidebar-muted-foreground",
  sidebarControlSurface: "--app-theme-sidebar-control-surface",
  sidebarRowHover: "--app-theme-sidebar-row-hover",
  sidebarRowActive: "--app-theme-sidebar-row-active",
  sidebarRowSelected: "--app-theme-sidebar-row-selected",
  sidebarBorder: "--app-theme-sidebar-border",
  terminalBackground: "--app-theme-terminal-background",
  terminalForeground: "--app-theme-terminal-foreground",
  terminalCursor: "--app-theme-terminal-cursor",
  terminalSelection: "--app-theme-terminal-selection-background",
  terminalScrollbar: "--app-theme-terminal-scrollbar",
  terminalScrollbarHover: "--app-theme-terminal-scrollbar-hover",
};

export function getThemeColorVariable(role: ThemeColorRole): string {
  return APP_THEME_VARIABLES[role];
}

export const THEME_PREVIEW_ID = "__preview";

export function applyThemeColorPreview(colors: ThemeColors, appearance: ThemeAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style) return;
  root.dataset.themeId = THEME_PREVIEW_ID;
  root.classList.toggle("dark", appearance === "dark");
  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
    if (isThemeColor(value)) root.style.setProperty(APP_THEME_VARIABLES[role], value);
  }
}

export function applyThemePalette(theme: ThemePreference, appearance?: ThemeAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style) return;
  const palette = getThemeDefinition(theme);
  if (palette) {
    root.dataset.themeId = palette.id;
    const mode = appearance ?? legacyThemeMode(theme) ?? palette.appearance;
    const colors = getThemeColorsForMode(palette, mode) ?? palette.colors;
    for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
      root.style.setProperty(APP_THEME_VARIABLES[role], value);
    }
    return;
  }
  delete root.dataset.themeId;
  for (const variable of Object.values(APP_THEME_VARIABLES)) root.style.removeProperty(variable);
}

export function resolveThemeAppearance(
  theme: ThemePreference,
  systemDark: boolean,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves?: ThemeHalves | null,
): "light" | "dark" {
  const systemAppearance = systemDark ? "dark" : "light";
  const mode = appearanceMode ?? ((followSystem ?? theme === "system") ? "system" : null);
  if (mode === "system") {
    if (halves?.[systemAppearance]) return systemAppearance;
    const definition = getThemeDefinition(theme);
    return definition && getThemeColorsForMode(definition, systemAppearance) === null
      ? definition.appearance
      : systemAppearance;
  }
  if (mode === "light" || mode === "dark") {
    if (halves?.[mode]) return mode;
    const definition = getThemeDefinition(theme);
    return definition && getThemeColorsForMode(definition, mode) === null
      ? definition.appearance
      : mode;
  }
  return getThemePreferenceMode(theme) ?? "light";
}

export function resolveDesktopTheme(
  theme: ThemePreference,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves?: ThemeHalves | null,
): "light" | "dark" | "system" {
  const mode = appearanceMode ?? ((followSystem ?? theme === "system") ? "system" : null);
  if (mode === "system") {
    const definition = getThemeDefinition(theme);
    const hasLightMode = halves?.light !== undefined || (definition !== null && getThemeColorsForMode(definition, "light") !== null);
    const hasDarkMode = halves?.dark !== undefined || (definition !== null && getThemeColorsForMode(definition, "dark") !== null);
    return definition && (!hasLightMode || !hasDarkMode) ? definition.appearance : "system";
  }
  if (mode === "light" || mode === "dark") {
    if (halves?.[mode]) return mode;
    const definition = getThemeDefinition(theme);
    return definition && getThemeColorsForMode(definition, mode) === null
      ? definition.appearance
      : mode;
  }
  return getThemePreferenceMode(theme) ?? "system";
}

export function isKnownThemePreference(theme: string): boolean {
  if (theme === "light" || theme === "dark" || theme === "system") return true;
  return getThemeDefinition(theme) !== null;
}

export type ThemeHalves = Readonly<{ light?: string; dark?: string }>;

export function parseThemeHalves(raw: string | null): ThemeHalves | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const halves: { light?: string; dark?: string } = {};
    for (const appearance of ["light", "dark"] as const) {
      const themeId = value[appearance];
      if (typeof themeId !== "string") continue;
      const definition = getThemeDefinition(themeId);
      if (definition && getThemeColorsForMode(definition, appearance) !== null) halves[appearance] = definition.id;
    }
    return halves.light !== undefined || halves.dark !== undefined ? halves : null;
  } catch {
    return null;
  }
}

export function resolveThemeHalf(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
): ThemePreference {
  return halves?.[appearance] ?? theme;
}
