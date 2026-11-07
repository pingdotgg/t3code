import { resolveThemeSelectionAppearance } from "@t3tools/shared/themeSelection";
import {
  parseThemeSource,
  resolveThemeSource,
  resolveThemeDefinition,
  getStandardPaintedThemeColors,
  type ThemeRgbColor,
  THEME_WHITE_FOREGROUND,
  THEME_BLACK_FOREGROUND,
  parseThemeColor,
  toCanonicalThemeColor,
  themeRgbToHexColor,
  decodeThemeColors,
  mixThemeRgbColors,
  themeRelativeLuminance,
  themeOklchToRgb,
  solveOklchLightness,
  createVividThemeColors,
  themeContrastRatio,
  getDefaultThemeColors,
} from "@t3tools/shared/themeResolution";
export {
  getStandardThemeColors,
  getStandardPaintedThemeColors,
  toCanonicalThemeColor,
  themeColorToHex,
  readableThemeColorOn,
  createVividThemeColors,
  getDefaultThemeColors,
  updateThemeColorFamily,
  resolveThemeDefinition as getThemeColorsForMode,
} from "@t3tools/shared/themeResolution";
import type { EnvironmentTheme } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import {
  BUILT_IN_THEMES,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  T3_CHAT_THEME,
  RESERVED_THEME_IDS,
  THEME_COLOR_ROLES,
  DEPRECATED_THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariants,
} from "@t3tools/shared/themePalettes";
import {
  CONTEXT_CHIP_ACCENTS,
  contextChipColorVariable,
  type ContextChipAccentKind,
} from "./lib/contextChipAccents";

import { appAtomRegistry, subscribeAtomChanges } from "./rpc/atomRegistry";
import { themeServerEnvironmentThemesAtom } from "./state/server";

export { EMBER_THEME, GROVE_THEME, IRIS_THEME, OCEAN_THEME, T3_CHAT_THEME, THEME_COLOR_ROLES };
export type { ThemeAppearance, ThemeColorRole, ThemeColors, ThemeDefinition, ThemeVariants };

const T3_CHAT_THEME_ID = "t3-chat" as const;
const GROVE_THEME_ID = "grove" as const;
const OCEAN_THEME_ID = "ocean" as const;
const EMBER_THEME_ID = "ember" as const;
const IRIS_THEME_ID = "iris" as const;
export const THEME_FILE_VERSION = 1 as const;
export const CUSTOM_THEMES_STORAGE_KEY = "t3code:themes:v1";
export const THEME_FOLLOW_SYSTEM_STORAGE_KEY = "t3code:theme-follow-system";
export const THEME_APPEARANCE_MODE_STORAGE_KEY = "t3code:theme-appearance-mode";
export const THEME_HALVES_STORAGE_KEY = "t3code:theme-halves:v1";

const LEGACY_T3_CHAT_DARK_THEME_ID = "t3-chat-dark";

export const ThemePreference = Schema.String;
export type ThemePreference = typeof ThemePreference.Type;

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>;
export type ThemeVariantOverrides = Readonly<Partial<Record<ThemeAppearance, ThemeColorOverrides>>>;
export type ThemePreferenceMode = ThemeAppearance | "system";
export type ThemeCollection = Readonly<{ id: string; label: string }>;
export type ThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColorOverrides;
  variants?: ThemeVariantOverrides;
  collection?: ThemeCollection;
  managed?: boolean;
}>;

const customThemeListeners = new Set<() => void>();
type CustomThemeLibrarySnapshot =
  | Readonly<{
      status: "ready";
      storedThemes: ReadonlyArray<unknown>;
      themes: ReadonlyArray<ThemeDefinition>;
    }>
  | Readonly<{ status: "unavailable"; reason: "malformed" }>
  | Readonly<{ status: "unavailable"; reason: "storage-unavailable"; cause: unknown }>;

let customThemeLibrarySnapshot: CustomThemeLibrarySnapshot | null = null;
const themePreviewListeners = new Set<() => void>();
let themePreviewAppearance: ThemeAppearance | null = null;

export function getThemePreviewAppearance(): ThemeAppearance | null {
  return themePreviewAppearance;
}

export function getThemePreviewSidebarArtwork(): boolean | null {
  return themePreviewAppearance === null ? null : false;
}

export function subscribeToThemePreview(listener: () => void): () => void {
  themePreviewListeners.add(listener);
  return () => themePreviewListeners.delete(listener);
}

function setThemePreviewAppearance(appearance: ThemeAppearance | null): void {
  if (themePreviewAppearance === appearance) return;
  themePreviewAppearance = appearance;
  for (const listener of themePreviewListeners) listener();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

export function isThemeColor(value: unknown): value is string {
  return typeof value === "string" && toCanonicalThemeColor(value) !== null;
}

function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

function parseThemeCollection(value: unknown): ThemeCollection | undefined {
  return isRecord(value) &&
    typeof value.id === "string" &&
    /^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id) &&
    isThemeLabel(value.label)
    ? { id: value.id, label: value.label.trim() }
    : undefined;
}

function lenientThemeColorOverrides(
  value: Readonly<Record<string, unknown>>,
): Partial<Record<ThemeColorRole, string>> {
  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    const normalized = toCanonicalThemeColor(color);
    if (THEME_COLOR_ROLE_SET.has(role) && normalized) {
      overrides[role as ThemeColorRole] = normalized;
    }
  }
  return overrides;
}

function parseStoredThemeColors(value: unknown, appearance: ThemeAppearance): ThemeColors | null {
  if (!isRecord(value)) return null;
  return { ...getDefaultThemeColors(appearance), ...lenientThemeColorOverrides(value) };
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
    // Base colors shadow a matching variant; drop it for parseThemeFile round-trips.
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
  const collection = parseThemeCollection(value.collection);
  const sources: NonNullable<ThemeDefinition["sources"]> = {};
  if (value.sources !== undefined) {
    if (!isRecord(value.sources)) return null;
    try {
      Object.assign(
        sources,
        Object.fromEntries(
          Object.entries(value.sources).map(([mode, source]) => {
            if (!isThemeAppearance(mode)) throw new Error("Invalid appearance.");
            return [mode, parseThemeSource(source)];
          }),
        ),
      );
    } catch {
      return null;
    }
  }

  const resolvedVariants = { ...variants };
  for (const mode of ["light", "dark"] as const) {
    const source = sources[mode];
    if (source && mode !== value.appearance)
      resolvedVariants[mode] = resolveThemeSource(source, mode);
  }
  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors: sources[value.appearance]
      ? resolveThemeSource(sources[value.appearance]!, value.appearance)
      : colors,
    ...(value.sources === undefined ? {} : { sources }),
    ...(Object.keys(resolvedVariants).length ? { variants: resolvedVariants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

function parseStoredThemes(storedThemes: ReadonlyArray<unknown>): ReadonlyArray<ThemeDefinition> {
  const themes: ThemeDefinition[] = [];
  for (const value of storedThemes) {
    const theme = parseStoredTheme(value);
    if (theme && !themes.some((existing) => existing.id === theme.id)) {
      themes.push(theme);
    }
  }
  return themes;
}

function readCustomThemeLibrarySnapshot(): CustomThemeLibrarySnapshot {
  if (typeof window === "undefined") {
    return { status: "ready", storedThemes: [], themes: [] };
  }

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  } catch (cause) {
    return { status: "unavailable", reason: "storage-unavailable", cause };
  }
  if (!raw) return { status: "ready", storedThemes: [], themes: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unavailable", reason: "malformed" };
  }
  if (!Array.isArray(parsed)) return { status: "unavailable", reason: "malformed" };

  return { status: "ready", storedThemes: parsed, themes: parseStoredThemes(parsed) };
}

function getCustomThemeLibrarySnapshot(): CustomThemeLibrarySnapshot {
  if (customThemeLibrarySnapshot === null) {
    customThemeLibrarySnapshot = readCustomThemeLibrarySnapshot();
  }
  return customThemeLibrarySnapshot;
}

function notifyCustomThemeListeners() {
  for (const listener of customThemeListeners) listener();
}

export function invalidateCustomThemes() {
  customThemeLibrarySnapshot = null;
  notifyCustomThemeListeners();
}

const EMPTY_CUSTOM_THEMES: ReadonlyArray<ThemeDefinition> = [];

export function getCustomThemes(): ReadonlyArray<ThemeDefinition> {
  const snapshot = getCustomThemeLibrarySnapshot();
  return snapshot.status === "ready" ? snapshot.themes : EMPTY_CUSTOM_THEMES;
}

function publishedThemeColors(
  theme: EnvironmentTheme,
  appearance: ThemeAppearance,
  colors: Readonly<Record<string, string>> | undefined,
): ThemeColors {
  // A variant builds on that appearance's stock defaults: the generator follows
  // the seed canvas's luminance, so dark seeds would give a light variant
  // unreadable colors.
  const base =
    appearance === theme.appearance && theme.canvas !== undefined && theme.accent !== undefined
      ? createVividThemeColors(appearance, theme.canvas, theme.accent)
      : getDefaultThemeColors(appearance);
  return { ...base, ...lenientThemeColorOverrides(colors ?? {}) };
}

function environmentThemeDefinition(theme: EnvironmentTheme): ThemeDefinition {
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const [variantAppearance, variantColors] of Object.entries(theme.variants ?? {})) {
    if (variantAppearance === theme.appearance) continue;
    variants[variantAppearance as ThemeAppearance] = publishedThemeColors(
      theme,
      variantAppearance as ThemeAppearance,
      variantColors,
    );
  }

  return {
    id: theme.id,
    label: theme.name,
    appearance: theme.appearance,
    colors: publishedThemeColors(theme, theme.appearance, theme.colors),
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    // Only the pure seeded form is guided-generator output. An exported file,
    // or seeds carrying explicit role overrides, must open Duplicate in the
    // advanced editor -- the guided one regenerates from canvas and accent and
    // would discard whatever the machine hand-tuned.
    ...(theme.canvas !== undefined &&
    theme.accent !== undefined &&
    theme.colors === undefined &&
    theme.variants === undefined
      ? { managed: true }
      : {}),
  };
}

/**
 * Published palettes this client can render. Reserved ids are dropped here rather
 * than rendered: a published `t3-iris.json` would show this palette on its
 * card while "Use" resolved the built-in, and a published `dark.json` would
 * capture everyone whose stored preference is the stock `"dark"`.
 */
export function publishedThemeDefinitions(
  themes: ReadonlyArray<EnvironmentTheme>,
): ReadonlyArray<ThemeDefinition> {
  return themes
    .filter((theme) => {
      if (isReservedThemeId(theme.id)) return false;
      if (theme.canvas !== undefined && theme.accent !== undefined) return true;
      const otherAppearance = theme.appearance === "dark" ? "light" : "dark";
      return [theme.colors, theme.variants?.[otherAppearance]].some(
        (colors) =>
          colors !== undefined && Object.keys(lenientThemeColorOverrides(colors)).length > 0,
      );
    })
    .map(environmentThemeDefinition);
}

// Every reconnect snapshot delivers a fresh but usually identical array; keeping the
// previous one skips regenerating palettes and repainting the document for it.
const publishedThemesAtom = Atom.make((get): ReadonlyArray<EnvironmentTheme> => {
  const next = get(themeServerEnvironmentThemesAtom);
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentTheme>>());
  return previous !== null && Equal.equals(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-published-environment-themes"));

/**
 * The environment's palettes are not saved: they are republished by the server
 * on every change and would go stale the moment the machine's theme moved on.
 * Kept alive because theme lookups read it outside React on every repaint.
 */
export const environmentThemeDefinitionsAtom = Atom.make((get) =>
  publishedThemeDefinitions(get(publishedThemesAtom)),
).pipe(Atom.keepAlive, Atom.withLabel("web-environment-theme-definitions"));

function getEnvironmentThemes(): ReadonlyArray<ThemeDefinition> {
  return appAtomRegistry.get(environmentThemeDefinitionsAtom);
}

export function isReservedThemeId(themeId: string): boolean {
  return RESERVED_THEME_IDS.has(themeId);
}

export function getStoredCustomThemeCollection(
  collectionId: string,
): ReadonlyArray<ThemeDefinition> {
  return readWritableCustomThemeLibrary().themes.filter(
    (theme) => theme.collection?.id === collectionId,
  );
}

export function subscribeToCustomThemes(listener: () => void): () => void {
  customThemeListeners.add(listener);
  const unsubscribeEnvironment = subscribeAtomChanges(environmentThemeDefinitionsAtom, () =>
    listener(),
  );
  if (typeof window === "undefined") {
    return () => {
      customThemeListeners.delete(listener);
      unsubscribeEnvironment();
    };
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_THEMES_STORAGE_KEY || event.key === null) {
      invalidateCustomThemes();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    customThemeListeners.delete(listener);
    unsubscribeEnvironment();
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

function canonicalizeThemeDefinition(theme: ThemeDefinition): ThemeDefinition {
  return {
    ...theme,
    colors: decodeThemeColors(resolveThemeDefinition(theme, theme.appearance) ?? theme.colors),
    ...(theme.variants
      ? {
          variants: Object.fromEntries(
            Object.entries(theme.variants).map(([appearance, colors]) => [
              appearance,
              decodeThemeColors(
                resolveThemeDefinition(theme, appearance as ThemeAppearance) ?? colors,
              ),
            ]),
          ) as ThemeVariants,
        }
      : {}),
  };
}

const CONTEXT_CHIP_CONTRAST = 5;
const CONTEXT_CHIP_MESSAGE_VARIABLE = "--context-chip-message";
const CONTEXT_CHIP_INVALID_VARIABLE = "--context-chip-invalid";

export function contextChipVariables(colors: ThemeColors): Readonly<Record<string, string>> {
  // CSS paints surfaces from their unrounded OKLCH, so measure them unrounded.
  const parsedCanvas = parseThemeColor(colors.canvas);
  const canvas = parsedCanvas ? themeOklchToRgb(parsedCanvas.color, false) : THEME_WHITE_FOREGROUND;
  const onCanvas = (value: string) => {
    const parsed = parseThemeColor(value);
    return parsed
      ? mixThemeRgbColors(canvas, themeOklchToRgb(parsed.color, false), parsed.alpha)
      : canvas;
  };
  const isDark = (color: ThemeRgbColor) => themeRelativeLuminance(color) < 0.179;
  const messageMatchesCanvas = isDark(onCanvas(colors.messageSurface)) === isDark(canvas);
  const surfaces = [canvas, onCanvas(colors.surface), onCanvas(colors.surfaceRaised)];
  if (messageMatchesCanvas) surfaces.push(onCanvas(colors.messageSurface));
  const contrastOnSurfaces = (color: ThemeRgbColor) =>
    Math.min(...surfaces.map((surface) => themeContrastRatio(color, surface)));
  const blackContrast = contrastOnSurfaces(THEME_BLACK_FOREGROUND);
  const whiteContrast = contrastOnSurfaces(THEME_WHITE_FOREGROUND);
  const direction = blackContrast >= whiteContrast ? "darker" : "lighter";
  const minContrast = Math.min(CONTEXT_CHIP_CONTRAST, Math.max(blackContrast, whiteContrast));
  const accents: Array<[string, string]> = [
    ...(Object.entries(CONTEXT_CHIP_ACCENTS) as Array<[ContextChipAccentKind, string]>).map(
      ([kind, accent]): [string, string] => [contextChipColorVariable(kind), accent],
    ),
    [CONTEXT_CHIP_INVALID_VARIABLE, colors.errorForeground],
  ];
  const variables: Record<string, string> = Object.fromEntries(
    accents.flatMap(([variable, accent]) => {
      const parsed = parseThemeColor(accent);
      if (!parsed) return [];
      const solved = solveOklchLightness(parsed.color, surfaces, minContrast, direction);
      return [[variable, themeRgbToHexColor(themeOklchToRgb(solved))]];
    }),
  );
  if (!messageMatchesCanvas) variables[CONTEXT_CHIP_MESSAGE_VARIABLE] = colors.messageForeground;
  return variables;
}

function applyContextChipVariables(root: HTMLElement, colors: ThemeColors): void {
  const variables = contextChipVariables(colors);
  root.style.removeProperty(CONTEXT_CHIP_MESSAGE_VARIABLE);
  root.style.removeProperty(CONTEXT_CHIP_INVALID_VARIABLE);
  for (const [variable, value] of Object.entries(variables)) {
    root.style.setProperty(variable, value);
  }
}

const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = BUILT_IN_THEMES;

export function getThemeDefinition(theme: ThemePreference): ThemeDefinition | null {
  const themeId = themeIdFromPreference(theme);
  return (
    BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === themeId) ??
    getCustomThemes().find((definition) => definition.id === themeId) ??
    getEnvironmentThemes().find((definition) => definition.id === themeId) ??
    null
  );
}

export function themeAllowsSidebarArtwork(theme: ThemePreference): boolean {
  const themeId = themeIdFromPreference(theme);
  return (
    BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === themeId)?.sidebarArtwork ===
    true
  );
}

/** Every selection path must check single-appearance themes to keep mix and appearance tiles in sync. */
export function singleAppearanceOf(theme: ThemeDefinition): ThemeAppearance | null {
  const modes = getThemeModes(theme);
  return modes.length === 1 ? modes[0]! : null;
}

export function getThemeModes(theme: ThemeDefinition): ReadonlyArray<ThemeAppearance> {
  return (["light", "dark"] as const).filter(
    (mode) => resolveThemeDefinition(theme, mode) !== null,
  );
}

export function getThemePreferenceMode(theme: ThemePreference): ThemeAppearance | null {
  if (theme === "system") return null;
  if (theme === "light" || theme === "dark") return theme;
  const legacyMode = legacyThemeMode(theme);
  if (legacyMode) return legacyMode;
  return getThemeDefinition(theme)?.appearance ?? null;
}

export function themeIdFromName(name: string): string {
  const label = name.trim().toLowerCase();
  const normalized = label
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (normalized || !label) return normalized || "custom-theme";

  // Names without ASCII letters or digits still need independent, stable ids.
  let hash = 2_166_136_261;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `theme-${(hash >>> 0).toString(36)}`;
}

export class ThemeLibraryStorageError extends Schema.TaggedError<ThemeLibraryStorageError>()(
  "ThemeLibraryStorageError",
  {
    storageKey: Schema.String,
    operation: Schema.Literals(["read", "write"]),
    reason: Schema.Literals(["malformed", "storage-unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const direction = this.operation === "read" ? "from" : "to";
    return `Failed to ${this.operation} the theme library ${direction} ${this.storageKey}.`;
  }
}

function saveCustomThemes(
  storedThemes: ReadonlyArray<unknown>,
  themes: ReadonlyArray<ThemeDefinition>,
): void {
  if (typeof window === "undefined") return;
  try {
    if (
      themes.some((theme) => theme.sources) &&
      window.localStorage.getItem(`${CUSTOM_THEMES_STORAGE_KEY}:original`) === null
    ) {
      const original = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
      if (original !== null)
        window.localStorage.setItem(`${CUSTOM_THEMES_STORAGE_KEY}:original`, original);
    }
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(storedThemes));
    customThemeLibrarySnapshot = { status: "ready", storedThemes, themes };
  } catch (cause) {
    throw new ThemeLibraryStorageError({
      storageKey: CUSTOM_THEMES_STORAGE_KEY,
      operation: "write",
      reason: "storage-unavailable",
      cause,
    });
  }
  notifyCustomThemeListeners();
}

function requireWritableCustomThemeLibrary(
  snapshot: CustomThemeLibrarySnapshot,
): Extract<CustomThemeLibrarySnapshot, { status: "ready" }> {
  if (snapshot.status === "unavailable") {
    throw new ThemeLibraryStorageError({
      storageKey: CUSTOM_THEMES_STORAGE_KEY,
      operation: "read",
      reason: snapshot.reason,
      ...("cause" in snapshot ? { cause: snapshot.cause } : {}),
    });
  }
  return snapshot;
}

function getWritableCustomThemeLibrary(): Extract<CustomThemeLibrarySnapshot, { status: "ready" }> {
  return requireWritableCustomThemeLibrary(getCustomThemeLibrarySnapshot());
}

function readWritableCustomThemeLibrary(): Extract<
  CustomThemeLibrarySnapshot,
  { status: "ready" }
> {
  return requireWritableCustomThemeLibrary(readCustomThemeLibrarySnapshot());
}

function storedThemeHasId(storedTheme: unknown, themeId: string): boolean {
  return isRecord(storedTheme) && storedTheme.id === themeId;
}

function storedThemeHasCollectionId(storedTheme: unknown, collectionId: string): boolean {
  return (
    isRecord(storedTheme) &&
    isRecord(storedTheme.collection) &&
    storedTheme.collection.id === collectionId
  );
}

export function installCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }
  const library = getWritableCustomThemeLibrary();
  if (
    BUILT_IN_THEME_DEFINITIONS.some((existing) => existing.id === theme.id) ||
    library.storedThemes.some((storedTheme) => storedThemeHasId(storedTheme, theme.id))
  ) {
    throw new Error(`A theme named "${theme.label}" is already installed.`);
  }
  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const themes = [...library.themes, canonicalTheme];
  saveCustomThemes([...library.storedThemes, canonicalTheme], themes);
  return canonicalTheme;
}

export function updateCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }

  const library = getWritableCustomThemeLibrary();
  const themes = library.themes;
  const themeIndex = themes.findIndex((existing) => existing.id === theme.id);
  if (themeIndex === -1) {
    throw new Error(`The theme "${theme.label}" is not installed.`);
  }

  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const nextThemes = [...themes];
  nextThemes[themeIndex] = canonicalTheme;

  const nextStoredThemes: unknown[] = [];
  let replaced = false;
  for (const storedTheme of library.storedThemes) {
    if (!storedThemeHasId(storedTheme, theme.id)) {
      nextStoredThemes.push(storedTheme);
    } else if (!replaced) {
      nextStoredThemes.push(canonicalTheme);
      replaced = true;
    }
  }
  saveCustomThemes(nextStoredThemes, nextThemes);
  return canonicalTheme;
}

export function replaceCustomThemeCollection(
  collectionId: string,
  themes: ReadonlyArray<ThemeDefinition>,
  options?: { expectedCollection?: ReadonlyArray<ThemeDefinition> },
): ReadonlyArray<ThemeDefinition> {
  if (themes.length === 0) throw new Error("A theme collection cannot be empty.");

  const validated = themes.map((theme) => parseStoredTheme(theme));
  if (
    validated.some((theme) => theme === null || theme.collection?.id !== collectionId) ||
    new Set(validated.map((theme) => theme?.id)).size !== validated.length
  ) {
    throw new Error("That theme collection is invalid.");
  }
  const replacement = validated as ThemeDefinition[];
  const library = readWritableCustomThemeLibrary();
  const current = library.themes;
  const currentCollection = current.filter((theme) => theme.collection?.id === collectionId);
  if (
    options?.expectedCollection &&
    JSON.stringify(currentCollection) !== JSON.stringify(options.expectedCollection)
  ) {
    throw new Error("Your installed themes changed while this package was downloading. Try again.");
  }
  const occupiedIds = new Set(BUILT_IN_THEME_DEFINITIONS.map((theme) => theme.id));
  for (const storedTheme of library.storedThemes) {
    if (
      !storedThemeHasCollectionId(storedTheme, collectionId) &&
      isRecord(storedTheme) &&
      typeof storedTheme.id === "string"
    ) {
      occupiedIds.add(storedTheme.id);
    }
  }
  const conflictingTheme = replacement.find(
    (theme) => RESERVED_THEME_IDS.has(theme.id) || occupiedIds.has(theme.id),
  );
  if (conflictingTheme) {
    throw new Error(`A theme named "${conflictingTheme.label}" is already installed.`);
  }

  const nextStoredThemes: unknown[] = [];
  let insertedReplacement = false;
  for (const storedTheme of library.storedThemes) {
    if (!storedThemeHasCollectionId(storedTheme, collectionId)) {
      nextStoredThemes.push(storedTheme);
    } else if (!insertedReplacement) {
      nextStoredThemes.push(...replacement);
      insertedReplacement = true;
    }
  }
  if (!insertedReplacement) nextStoredThemes.push(...replacement);

  saveCustomThemes(nextStoredThemes, parseStoredThemes(nextStoredThemes));
  return replacement;
}

export function removeCustomTheme(themeId: string): void {
  removeCustomThemes([themeId]);
}

export function removeCustomThemes(themeIds: ReadonlyArray<string>): void {
  const removedIds = new Set(themeIds);
  if (removedIds.size === 0) return;
  const library = getWritableCustomThemeLibrary();
  const nextThemes = library.themes.filter((theme) => !removedIds.has(theme.id));
  if (nextThemes.length === library.themes.length) return;
  saveCustomThemes(
    library.storedThemes.filter(
      (storedTheme) =>
        !isRecord(storedTheme) ||
        typeof storedTheme.id !== "string" ||
        !removedIds.has(storedTheme.id),
    ),
    nextThemes,
  );
}

function parseThemeColorOverrides(value: unknown): ThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");

  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (DEPRECATED_THEME_COLOR_ROLES.has(role)) continue;
    if (!THEME_COLOR_ROLE_SET.has(role)) {
      throw new Error(`"${role}" is not a supported theme color role.`);
    }
    const normalized = toCanonicalThemeColor(color);
    if (!normalized) {
      throw new Error(
        `The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`,
      );
    }
    overrides[role as ThemeColorRole] = normalized;
  }
  if (Object.keys(overrides).length === 0) {
    throw new Error("Add at least one color role to the theme file.");
  }
  return overrides;
}

export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) {
    throw new Error("Theme files must contain a JSON object.");
  }
  if (value.version !== THEME_FILE_VERSION && value.version !== 2) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }

  const name = value.name;
  const appearance = value.appearance;
  const rawColors = value.colors;
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).");
  if (!isThemeAppearance(appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }
  if (!isRecord(rawColors)) throw new Error("Theme files need a colors object.");

  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (!isThemeId(id)) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }
  if (RESERVED_THEME_IDS.has(id)) {
    throw new Error(`The theme id "${id}" is reserved.`);
  }

  if (value.version === 2 || value.sources !== undefined) {
    const stored = parseStoredTheme({ ...value, id, label: name });
    if (!stored || !stored.sources) throw new Error("Theme files need valid authored sources.");
    return stored;
  }

  const overrides = parseThemeColorOverrides(rawColors);
  const collection = parseThemeCollection(value.collection);
  if (value.collection !== undefined && !collection) {
    throw new Error("Theme collections need a valid id and label.");
  }

  const fallback = getDefaultThemeColors(appearance);
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }
      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }
      const variantFallback = getDefaultThemeColors(variantAppearance);
      variants[variantAppearance] = {
        ...variantFallback,
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
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export function serializeThemeFile(theme: ThemeDefinition, options?: { legacy?: boolean }): string {
  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: canonicalTheme.id,
    name: canonicalTheme.label,
    appearance: canonicalTheme.appearance,
    colors: canonicalTheme.colors,
    ...(canonicalTheme.variants ? { variants: canonicalTheme.variants } : {}),
    ...(canonicalTheme.collection ? { collection: canonicalTheme.collection } : {}),
    ...(canonicalTheme.managed ? { managed: true } : {}),
  };
  const output =
    canonicalTheme.sources && !options?.legacy
      ? { ...file, sources: canonicalTheme.sources }
      : file;
  return `${JSON.stringify(output, null, 2)}\n`;
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
  searchMatchBackground: "--app-theme-search-match-background",
  searchMatchForeground: "--app-theme-search-match-foreground",
  searchMatchActiveBackground: "--app-theme-search-match-active-background",
  searchMatchActiveForeground: "--app-theme-search-match-active-foreground",
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
};

export function getThemeColorVariable(role: ThemeColorRole): string {
  return APP_THEME_VARIABLES[role];
}

export const THEME_PREVIEW_ID = "__preview";

/** Callers must restore the stored theme with refreshTheme when the draft closes. */
export function applyThemeColorPreview(colors: ThemeColors, appearance: ThemeAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style) return;

  root.dataset.themeId = THEME_PREVIEW_ID;
  delete root.dataset.themeInlineCode;
  delete root.dataset.themeSidebarDivider;
  delete root.dataset.themeGrainSize;
  root.classList.toggle("dark", appearance === "dark");
  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
    if (isThemeColor(value)) root.style.setProperty(APP_THEME_VARIABLES[role], value);
  }
  applyContextChipVariables(root, colors);
  setThemePreviewAppearance(appearance);
}

export function applyThemePalette(theme: ThemePreference, appearance?: ThemeAppearance): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  if (!root?.style) return;

  setThemePreviewAppearance(null);
  const palette = getThemeDefinition(theme);
  const presentation = palette?.presentation;
  for (const [key, value] of Object.entries({
    themeInlineCode: presentation?.inlineCodeSurface,
    themeSidebarDivider: presentation?.sidebarDivider,
    themeGrainSize: presentation?.grainSize?.toString(),
  })) {
    if (value === undefined) delete root.dataset[key];
    else root.dataset[key] = value;
  }

  const mode = appearance ?? (palette ? (legacyThemeMode(theme) ?? palette.appearance) : "light");
  const colors = palette
    ? (resolveThemeDefinition(palette, mode) ?? palette.colors)
    : getStandardPaintedThemeColors(mode);
  root.dataset.themeId = palette?.id ?? "t3-code";
  for (const role of THEME_COLOR_ROLES) {
    root.style.setProperty(APP_THEME_VARIABLES[role], colors[role]);
  }
  applyContextChipVariables(root, colors);
}

export function resolveThemeAppearance(
  theme: ThemePreference,
  systemDark: boolean,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves?: ThemeHalves | null,
): "light" | "dark" {
  const mode = appearanceMode ?? ((followSystem ?? theme === "system") ? "system" : null);
  const definition = getThemeDefinition(theme);
  const wanted = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  return resolveThemeSelectionAppearance({
    mode,
    systemDark,
    baseAppearance: getThemePreferenceMode(theme) ?? "light",
    appearances: definition ? getThemeModes(definition) : null,
    hasHalf: wanted !== null && halves?.[wanted] !== undefined,
  });
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
    const hasLightMode =
      halves?.light !== undefined ||
      (definition !== null && resolveThemeDefinition(definition, "light") !== null);
    const hasDarkMode =
      halves?.dark !== undefined ||
      (definition !== null && resolveThemeDefinition(definition, "dark") !== null);
    return definition && (!hasLightMode || !hasDarkMode) ? definition.appearance : "system";
  }
  if (mode === "light" || mode === "dark") {
    if (halves?.[mode]) return mode;
    const definition = getThemeDefinition(theme);
    return definition && resolveThemeDefinition(definition, mode) === null
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
      if (!definition || resolveThemeDefinition(definition, appearance) !== null) {
        halves[appearance] = definition?.id ?? themeId;
      }
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
