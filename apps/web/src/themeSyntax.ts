/**
 * VS Code editor highlighting stored on a T3 theme. `tokenColors` is the same
 * array a `*-color-theme.json` carries; chrome roles stay on `colors`.
 */

export type ThemeSyntaxAppearance = "light" | "dark";

export type VsCodeTokenColor = Readonly<{
  name?: string;
  scope?: string | ReadonlyArray<string>;
  settings?: Readonly<Record<string, unknown>>;
}>;

export type VsCodeSyntaxTheme = Readonly<{
  tokenColors: ReadonlyArray<VsCodeTokenColor>;
  semanticTokenColors?: Readonly<Record<string, unknown>>;
  colors?: Readonly<{
    "editor.foreground"?: string;
    "editor.background"?: string;
  }>;
}>;

export type ThemeSyntax = Readonly<Partial<Record<ThemeSyntaxAppearance, VsCodeSyntaxTheme>>>;

export const SYNTAX_THEME_JSON_PLACEHOLDER = `{
  "tokenColors": [
    {
      "scope": ["comment", "punctuation.definition.comment"],
      "settings": { "foreground": "#6a737d" }
    }
  ]
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeSyntaxAppearance(value: unknown): value is ThemeSyntaxAppearance {
  return value === "light" || value === "dark";
}

function asFiniteString(value: unknown, limit = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= limit ? trimmed : undefined;
}

function parseTokenColor(value: unknown): VsCodeTokenColor | null {
  if (!isRecord(value)) return null;
  const token: {
    name?: string;
    scope?: string | ReadonlyArray<string>;
    settings?: Readonly<Record<string, unknown>>;
  } = {};
  const name = asFiniteString(value.name, 128);
  if (name) token.name = name;
  if (typeof value.scope === "string") {
    const scope = asFiniteString(value.scope, 512);
    if (scope) token.scope = scope;
  } else if (Array.isArray(value.scope)) {
    const scope = value.scope
      .map((entry) => asFiniteString(entry, 512))
      .filter((entry): entry is string => entry !== undefined);
    if (scope.length > 0) token.scope = scope;
  }
  if (isRecord(value.settings)) token.settings = { ...value.settings };
  return token.scope !== undefined || token.settings !== undefined || token.name !== undefined
    ? token
    : null;
}

function parseTokenColors(value: unknown): ReadonlyArray<VsCodeTokenColor> | undefined {
  if (!Array.isArray(value)) return undefined;
  const tokenColors: VsCodeTokenColor[] = [];
  for (const entry of value) {
    const parsed = parseTokenColor(entry);
    if (parsed) tokenColors.push(parsed);
  }
  return tokenColors.length > 0 ? tokenColors : undefined;
}

function parseSemanticTokenColors(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const semanticTokenColors: Record<string, unknown> = {};
  for (const [key, color] of Object.entries(value)) {
    if (asFiniteString(key, 128)) semanticTokenColors[key] = color;
  }
  return Object.keys(semanticTokenColors).length > 0 ? semanticTokenColors : undefined;
}

function parseEditorColors(value: unknown): NonNullable<VsCodeSyntaxTheme["colors"]> | undefined {
  if (!isRecord(value)) return undefined;
  const foreground = asFiniteString(value["editor.foreground"]);
  const background = asFiniteString(value["editor.background"]);
  if (!foreground && !background) return undefined;
  return {
    ...(foreground ? { "editor.foreground": foreground } : {}),
    ...(background ? { "editor.background": background } : {}),
  };
}

export function extractVsCodeSyntax(value: unknown): VsCodeSyntaxTheme | undefined {
  if (!isRecord(value)) return undefined;
  const tokenColors = parseTokenColors(value.tokenColors);
  if (!tokenColors) return undefined;
  const semanticTokenColors = parseSemanticTokenColors(value.semanticTokenColors);
  const colors = parseEditorColors(value.colors);
  return {
    tokenColors,
    ...(semanticTokenColors ? { semanticTokenColors } : {}),
    ...(colors ? { colors } : {}),
  };
}

export function parseThemeSyntax(value: unknown): ThemeSyntax | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('Theme syntax must be an object keyed by "light" or "dark".');
  }

  const syntax: Partial<Record<ThemeSyntaxAppearance, VsCodeSyntaxTheme>> = {};
  for (const [appearance, snippet] of Object.entries(value)) {
    if (!isThemeSyntaxAppearance(appearance)) {
      throw new Error('Theme syntax may only be named "light" or "dark".');
    }
    const parsed = extractVsCodeSyntax(snippet);
    if (!parsed) {
      throw new Error(
        `Theme syntax for "${appearance}" needs a tokenColors array from a VS Code theme.`,
      );
    }
    syntax[appearance] = parsed;
  }
  return Object.keys(syntax).length > 0 ? syntax : undefined;
}

/** Stored themes drop malformed syntax rather than failing the whole palette. */
export function parseStoredThemeSyntax(value: unknown): ThemeSyntax | undefined {
  try {
    return parseThemeSyntax(value);
  } catch {
    return undefined;
  }
}

export type ApplySyntaxThemeJsonResult =
  | { ok: true; syntax: VsCodeSyntaxTheme | undefined }
  | { ok: false; error: string };

/**
 * Apply a live JSON editor value. Empty clears highlighting back to Pierre.
 * `{ tokenColors }` and a full VS Code `*-color-theme.json` both work; invalid
 * JSON is an error so the caller can keep the last good snippet.
 */
export function applySyntaxThemeJson(raw: string): ApplySyntaxThemeJsonResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, syntax: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "That JSON is not valid." };
  }

  const syntax = extractVsCodeSyntax(parsed);
  if (!syntax) {
    return {
      ok: false,
      error: 'Add a "tokenColors" array, or paste a VS Code color theme file.',
    };
  }
  return { ok: true, syntax };
}

export function formatSyntaxThemeJson(syntax: VsCodeSyntaxTheme | undefined): string {
  return syntax ? `${JSON.stringify(syntax, null, 2)}\n` : "";
}

export function mergeThemeSyntax(
  base: ThemeSyntax | undefined,
  overlay: ThemeSyntax | undefined,
): ThemeSyntax | undefined {
  if (!base && !overlay) return undefined;
  const merged: Partial<Record<ThemeSyntaxAppearance, VsCodeSyntaxTheme>> = {
    ...base,
    ...overlay,
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function syntaxFromAppearances(
  byAppearance: Partial<Record<ThemeSyntaxAppearance, VsCodeSyntaxTheme | undefined>>,
  appearances: ReadonlyArray<ThemeSyntaxAppearance>,
): ThemeSyntax | undefined {
  const syntax: Partial<Record<ThemeSyntaxAppearance, VsCodeSyntaxTheme>> = {};
  for (const appearance of appearances) {
    const snippet = byAppearance[appearance];
    if (snippet) syntax[appearance] = snippet;
  }
  return Object.keys(syntax).length > 0 ? syntax : undefined;
}

export function toShikiThemeJson(
  name: string,
  appearance: ThemeSyntaxAppearance,
  syntax: VsCodeSyntaxTheme,
): Record<string, unknown> {
  return {
    name,
    type: appearance,
    tokenColors: syntax.tokenColors,
    ...(syntax.semanticTokenColors ? { semanticTokenColors: syntax.semanticTokenColors } : {}),
    ...(syntax.colors ? { colors: syntax.colors } : {}),
  };
}
