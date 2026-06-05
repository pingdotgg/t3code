import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ColorMode = Schema.Literals(["system", "light", "dark"]);
export type ColorMode = typeof ColorMode.Type;

export const ThemeMode = Schema.Literals(["light", "dark"]);
export type ThemeMode = typeof ThemeMode.Type;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const HexColor = TrimmedNonEmptyString.check(Schema.isPattern(HEX_COLOR_PATTERN));
export type HexColor = typeof HexColor.Type;

export const AppearanceThemeSlot = Schema.Literals([
  "background",
  "foreground",
  "card",
  "cardForeground",
  "popover",
  "popoverForeground",
  "primary",
  "primaryForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
  "border",
  "input",
  "ring",
  "destructive",
  "destructiveForeground",
  "info",
  "infoForeground",
  "success",
  "successForeground",
  "warning",
  "warningForeground",
  "appChromeBackground",
]);
export type AppearanceThemeSlot = typeof AppearanceThemeSlot.Type;

export const ThemeDocumentSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  mode: ThemeMode,
  accentSeed: HexColor,
  backgroundSeed: HexColor,
  foregroundSeed: HexColor,
  neutralSeed: Schema.optionalKey(HexColor),
  semanticSlots: Schema.Record(TrimmedNonEmptyString, HexColor).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ThemeDocument = typeof ThemeDocumentSchema.Type;

export const DEFAULT_THEME_ID = "t3-dark";

export const AppearanceSettingsSchema = Schema.Struct({
  colorMode: ColorMode.pipe(Schema.withDecodingDefault(Effect.succeed("system"))),
  themeId: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_THEME_ID))),
});
export type AppearanceSettings = typeof AppearanceSettingsSchema.Type;

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = Schema.decodeSync(
  AppearanceSettingsSchema,
)({});
