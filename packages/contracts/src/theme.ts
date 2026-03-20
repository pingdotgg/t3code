import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const THEME_TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];

export const ThemePaletteId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
export type ThemePaletteId = typeof ThemePaletteId.Type;

const ThemePaletteLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(48));
const ThemePaletteDescription = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const ThemeTokenValue = TrimmedNonEmptyString.check(
  Schema.isMaxLength(160),
  Schema.isPattern(/^[^\n\r{};]+$/),
);

export const ThemePaletteTokens = Schema.Record(Schema.String, ThemeTokenValue);
export type ThemePaletteTokens = typeof ThemePaletteTokens.Type;

export const ThemePaletteDefinition = Schema.Struct({
  id: ThemePaletteId,
  label: ThemePaletteLabel,
  description: Schema.optional(ThemePaletteDescription),
  light: Schema.optional(ThemePaletteTokens),
  dark: Schema.optional(ThemePaletteTokens),
});
export type ThemePaletteDefinition = typeof ThemePaletteDefinition.Type;

export const ThemePaletteConfig = Schema.Array(ThemePaletteDefinition).check(
  Schema.isMaxLength(64),
);
export type ThemePaletteConfig = typeof ThemePaletteConfig.Type;
