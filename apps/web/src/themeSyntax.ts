export type ThemeTokenColorRule = Readonly<{
  name?: string;
  scope?: string | ReadonlyArray<string>;
  settings: Readonly<{
    foreground?: string;
    background?: string;
    fontStyle?: string;
  }>;
}>;

export type ThemeSyntax = Readonly<{ tokenColors: ReadonlyArray<ThemeTokenColorRule> }>;

export type NormalizedThemeTokenColors =
  | Readonly<{ status: "absent" | "invalid" | "too-many" }>
  | Readonly<{ status: "valid"; syntax: ThemeSyntax }>;

export const MAX_THEME_TOKEN_COLOR_RULES = 4_096;
const MAX_THEME_TOKEN_SCOPES_PER_RULE = 64;
const MAX_THEME_TOKEN_SCOPE_LENGTH = 512;
const MAX_THEME_TOKEN_RULE_NAME_LENGTH = 256;
const MAX_THEME_TOKEN_FONT_STYLE_LENGTH = 128;
const SYNTAX_COLOR_PATTERN = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const SYNTAX_FONT_STYLES = new Set(["italic", "bold", "underline", "strikethrough"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseThemeTokenScope(value: unknown): ThemeTokenColorRule["scope"] | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const scope = value.trim();
    return scope.length > 0 && scope.length <= MAX_THEME_TOKEN_SCOPE_LENGTH ? scope : null;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_THEME_TOKEN_SCOPES_PER_RULE
  ) {
    return null;
  }
  const scopes = value.map((scope) => (typeof scope === "string" ? scope.trim() : ""));
  return scopes.every((scope) => scope.length > 0 && scope.length <= MAX_THEME_TOKEN_SCOPE_LENGTH)
    ? scopes
    : null;
}

function normalizeSyntaxColor(value: unknown): string | undefined {
  if (typeof value !== "string" || !SYNTAX_COLOR_PATTERN.test(value)) return undefined;
  const hex = value.slice(1).toLowerCase();
  return `#${hex.length <= 4 ? [...hex].map((character) => character.repeat(2)).join("") : hex}`;
}

function parseThemeTokenColorRule(value: unknown): ThemeTokenColorRule | null {
  if (!isRecord(value) || !isRecord(value.settings)) return null;
  const scope = parseThemeTokenScope(value.scope);
  if (scope === null) return null;
  const foreground = normalizeSyntaxColor(value.settings.foreground);
  const background = normalizeSyntaxColor(value.settings.background);
  const rawFontStyle = value.settings.fontStyle;
  const fontStyle =
    typeof rawFontStyle === "string" &&
    rawFontStyle.length <= MAX_THEME_TOKEN_FONT_STYLE_LENGTH &&
    rawFontStyle
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((style) => SYNTAX_FONT_STYLES.has(style))
      ? rawFontStyle.trim()
      : undefined;
  if (foreground === undefined && background === undefined && fontStyle === undefined) return null;

  const name =
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.name.trim().length <= MAX_THEME_TOKEN_RULE_NAME_LENGTH
      ? value.name.trim()
      : undefined;
  return {
    ...(name ? { name } : {}),
    ...(scope ? { scope } : {}),
    settings: {
      ...(foreground ? { foreground } : {}),
      ...(background ? { background } : {}),
      ...(fontStyle !== undefined ? { fontStyle } : {}),
    },
  };
}

export function normalizeThemeTokenColors(value: unknown): NormalizedThemeTokenColors {
  if (!Array.isArray(value)) return { status: "absent" };
  if (value.length > MAX_THEME_TOKEN_COLOR_RULES) return { status: "too-many" };
  const tokenColors = value.flatMap((rule) => {
    const parsed = parseThemeTokenColorRule(rule);
    return parsed ? [parsed] : [];
  });
  if (value.length > 0 && tokenColors.length === 0) return { status: "invalid" };
  return { status: "valid", syntax: { tokenColors } };
}

export function parseThemeTokenColors(value: unknown): ThemeSyntax | null {
  if (!Array.isArray(value)) return null;
  const normalized = normalizeThemeTokenColors(value);
  return normalized.status === "valid" && normalized.syntax.tokenColors.length === value.length
    ? normalized.syntax
    : null;
}
