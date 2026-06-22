import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Contracts for the VSCode theme catalog. The server enumerates VSCode color
 * themes available on the user's machine (built-in themes shipped inside the
 * editor app bundle plus installed extension themes under
 * `~/.vscode/extensions`) and resolves a selected theme's JSON (including
 * `include` inheritance) for use by the in-app Shiki highlighter.
 */

export const VscodeThemeSource = Schema.Literals(["builtin", "extension"]);
export type VscodeThemeSource = typeof VscodeThemeSource.Type;

export const VscodeThemeType = Schema.Literals(["light", "dark"]);
export type VscodeThemeType = typeof VscodeThemeType.Type;

/** A theme as listed in the picker dropdown (no colors — just metadata). */
export const VscodeThemeSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  type: VscodeThemeType,
  source: VscodeThemeSource,
});
export type VscodeThemeSummary = typeof VscodeThemeSummary.Type;

export const VscodeThemeListResult = Schema.Struct({
  themes: Schema.Array(VscodeThemeSummary),
});
export type VscodeThemeListResult = typeof VscodeThemeListResult.Type;

export const VscodeThemeJsonInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type VscodeThemeJsonInput = typeof VscodeThemeJsonInput.Type;

/**
 * A fully-resolved theme. `theme` is the merged VSCode theme JSON (parent
 * `include` chain merged into the child) and is a valid input to Shiki's
 * theme registration. `background`/`foreground` are surfaced separately so the
 * client can drive the code-area background without re-parsing `theme`.
 */
export const VscodeThemeJsonResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  type: VscodeThemeType,
  background: Schema.optional(Schema.String),
  foreground: Schema.optional(Schema.String),
  theme: Schema.Unknown,
});
export type VscodeThemeJsonResult = typeof VscodeThemeJsonResult.Type;

export class VscodeThemeCatalogError extends Schema.TaggedErrorClass<VscodeThemeCatalogError>()(
  "VscodeThemeCatalogError",
  {
    operation: Schema.Literals(["list", "resolve"]),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
