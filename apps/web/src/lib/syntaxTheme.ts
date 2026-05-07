import {
  registerCustomTheme,
  type DiffsThemeNames,
  type ThemeRegistrationResolved,
} from "@pierre/diffs";
import type { ResolvedColorTheme } from "@t3tools/contracts";
import { isDarkThemeKind } from "@t3tools/shared/themeMapping";
import { resolveDiffThemeName } from "./diffRendering";

type BuiltInResolvedTheme = "light" | "dark";
type SyntaxColorTheme = Partial<ResolvedColorTheme>;
type ThemeSetting = ThemeRegistrationResolved["settings"][number];
type ThemeSettingOptions = ThemeSetting["settings"];

const registeredSyntaxThemes = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      normalized[key] = entry;
    }
  }
  return normalized;
}

function hashString(input: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function normalizeScopes(value: unknown): ThemeSetting["scope"] | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return undefined;
}

function normalizeThemeSettings(value: unknown): ThemeSettingOptions | null {
  if (!isRecord(value)) return null;

  const settings: ThemeSettingOptions = {
    ...(typeof value.foreground === "string" ? { foreground: value.foreground } : {}),
    ...(typeof value.background === "string" ? { background: value.background } : {}),
    ...(typeof value.fontStyle === "string" ? { fontStyle: value.fontStyle } : {}),
  };

  return Object.keys(settings).length > 0 ? settings : null;
}

function normalizeTokenColors(value: unknown): ThemeRegistrationResolved["settings"] {
  if (!Array.isArray(value)) return [];

  const settings: ThemeRegistrationResolved["settings"] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const tokenSettings = normalizeThemeSettings(entry.settings);
    if (!tokenSettings) continue;

    const scope = normalizeScopes(entry.scope);
    const next: ThemeSetting = {
      ...(scope ? { scope } : {}),
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      settings: tokenSettings,
    };
    settings.push(next);
  }
  return settings;
}

function syntaxThemeName(theme: SyntaxColorTheme, fallbackTheme: BuiltInResolvedTheme) {
  const colors = normalizeStringRecord(theme.colors);
  return `t3-syntax-${hashString(
    stableStringify({
      id: theme.id,
      kind: theme.kind ?? fallbackTheme,
      colors,
      tokenColors: theme.tokenColors,
      semanticHighlighting: theme.semanticHighlighting,
    }),
  )}`;
}

function toShikiTheme(
  theme: SyntaxColorTheme,
  name: string,
  fallbackTheme: BuiltInResolvedTheme,
): ThemeRegistrationResolved {
  const colors = normalizeStringRecord(theme.colors);
  const appVariables = normalizeStringRecord(theme.appVariables);
  const foreground = colors["editor.foreground"] ?? appVariables["--foreground"] ?? "#f5f5f5";
  const background = colors["editor.background"] ?? appVariables["--background"] ?? "#111111";
  const settings = normalizeTokenColors(theme.tokenColors);
  const isDark = theme.kind ? isDarkThemeKind(theme.kind) : fallbackTheme === "dark";

  return {
    name,
    displayName: theme.label ?? "Custom Theme",
    type: isDark ? "dark" : "light",
    fg: foreground,
    bg: background,
    colors: {
      ...colors,
      "editor.foreground": foreground,
      "editor.background": background,
    },
    settings,
    tokenColors: settings,
    ...(typeof theme.semanticHighlighting === "boolean"
      ? { semanticHighlighting: theme.semanticHighlighting }
      : {}),
  };
}

function registerSyntaxTheme(theme: SyntaxColorTheme, fallbackTheme: BuiltInResolvedTheme) {
  const name = syntaxThemeName(theme, fallbackTheme);
  if (registeredSyntaxThemes.has(name)) return name;

  const shikiTheme = toShikiTheme(theme, name, fallbackTheme);
  registerCustomTheme(name, async () => shikiTheme);
  registeredSyntaxThemes.add(name);
  return name;
}

export function resolveSyntaxThemeName(input: {
  readonly resolvedTheme: BuiltInResolvedTheme;
  readonly resolvedColorTheme: SyntaxColorTheme | null;
}): DiffsThemeNames {
  if (!input.resolvedColorTheme) {
    return resolveDiffThemeName(input.resolvedTheme);
  }
  return registerSyntaxTheme(input.resolvedColorTheme, input.resolvedTheme);
}

export const resolveCodeBlockThemeName = resolveSyntaxThemeName;
