import * as Schema from "effect/Schema";

export const ThemeSource = Schema.Literals(["builtin", "vscode", "cursor", "vscode-insiders"]);
export type ThemeSource = typeof ThemeSource.Type;

export const EditorThemeSource = Schema.Literals(["vscode", "cursor", "vscode-insiders"]);
export type EditorThemeSource = typeof EditorThemeSource.Type;

export const ThemeKind = Schema.Literals([
  "light",
  "dark",
  "high-contrast-light",
  "high-contrast-dark",
]);
export type ThemeKind = typeof ThemeKind.Type;

export type ThemeId = string;

export const DiscoveredColorTheme = Schema.Struct({
  id: Schema.String,
  source: EditorThemeSource,
  extensionId: Schema.String,
  extensionDisplayName: Schema.optional(Schema.String),
  label: Schema.String,
  kind: ThemeKind,
  themePath: Schema.String,
  packagePath: Schema.String,
  publisher: Schema.optional(Schema.String),
});
export type DiscoveredColorTheme = typeof DiscoveredColorTheme.Type;

export const ResolvedColorTheme = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  source: EditorThemeSource,
  kind: ThemeKind,
  colors: Schema.Record(Schema.String, Schema.String),
  tokenColors: Schema.Unknown,
  semanticHighlighting: Schema.optional(Schema.Boolean),
  semanticTokenColors: Schema.optional(Schema.Unknown),
  appVariables: Schema.Record(Schema.String, Schema.String),
});
export type ResolvedColorTheme = typeof ResolvedColorTheme.Type;

export const ThemePreference = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("system") }),
  Schema.Struct({ mode: Schema.Literal("builtin"), theme: Schema.Literals(["light", "dark"]) }),
  Schema.Struct({ mode: Schema.Literal("external"), themeId: Schema.String }),
  Schema.Struct({ mode: Schema.Literal("follow-editor"), source: EditorThemeSource }),
]);
export type ThemePreference = typeof ThemePreference.Type;

export const DEFAULT_THEME_PREFERENCE = { mode: "system" } as const satisfies ThemePreference;

export const EditorThemePreference = Schema.Struct({
  source: EditorThemeSource,
  colorTheme: Schema.NullOr(Schema.String),
  preferredLightColorTheme: Schema.NullOr(Schema.String),
  preferredDarkColorTheme: Schema.NullOr(Schema.String),
  autoDetectColorScheme: Schema.Boolean,
  workbenchColorCustomizations: Schema.Record(Schema.String, Schema.Unknown),
  editorTokenColorCustomizations: Schema.Unknown,
});
export type EditorThemePreference = typeof EditorThemePreference.Type;

export const DesktopWindowThemeColors = Schema.Struct({
  backgroundColor: Schema.String,
  titleBarColor: Schema.optional(Schema.String),
  titleBarSymbolColor: Schema.optional(Schema.String),
});
export type DesktopWindowThemeColors = typeof DesktopWindowThemeColors.Type;
