// Fork: the theme studio's data. A studio theme is a custom app theme rebuilt from a design
// record (the lab's colours, warmth, contrast, shape). Captured settings ride along untyped and
// are normalised in kaluwaStudioActions.ts, so this module stays free of app state.
import * as Schema from "effect/Schema";
import type { ThemeAppearance, ThemeDefinition } from "@t3tools/shared/themePalettes";

import {
  KALUWA_PRESETS,
  KALUWA_PRESET_IDS,
  mixHex,
  type KaluwaPreset,
  type KaluwaPresetId,
  type KaluwaSchemeColors,
} from "./kaluwaPalette";
import {
  KALUWA_STUDIO_THEME_PREFIX,
  kaluwaPresetThemeDefinition,
  type KaluwaThemeBuilders,
} from "./kaluwaThemes";

const KALUWA_STUDIO_COLOR_KEYS = [
  "bg",
  "chrome",
  "sidebar",
  "card",
  "composer",
  "fg",
  "muted",
  "accent",
  "accentFg",
] as const;
export type KaluwaStudioColorKey = (typeof KALUWA_STUDIO_COLOR_KEYS)[number];

export const KALUWA_STUDIO_LIMITS = {
  borderAlpha: [0, 30],
  warmth: [-100, 100],
  contrast: [-50, 50],
  radius: [0, 24],
  controlRadius: [0, 16],
  composerRadius: [0, 32],
  shadow: [0, 100],
} as const satisfies Record<string, readonly [number, number]>;

export const KALUWA_STUDIO_FONTS = ["system", "inter"] as const;

const Hex = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
const between = ([minimum, maximum]: readonly [number, number]) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

const SchemeColorsSchema = Schema.Struct({
  bg: Hex,
  chrome: Hex,
  sidebar: Hex,
  card: Hex,
  composer: Hex,
  fg: Hex,
  muted: Hex,
  accent: Hex,
  accentFg: Hex,
  borderAlpha: between(KALUWA_STUDIO_LIMITS.borderAlpha),
});

const DesignSchema = Schema.Struct({
  base: Schema.Literals(KALUWA_PRESET_IDS),
  scheme: Schema.Literals(["dark", "light"]),
  dark: SchemeColorsSchema,
  light: SchemeColorsSchema,
  warmth: between(KALUWA_STUDIO_LIMITS.warmth),
  contrast: between(KALUWA_STUDIO_LIMITS.contrast),
  radius: between(KALUWA_STUDIO_LIMITS.radius),
  controlRadius: between(KALUWA_STUDIO_LIMITS.controlRadius),
  composerRadius: between(KALUWA_STUDIO_LIMITS.composerRadius),
  shadow: between(KALUWA_STUDIO_LIMITS.shadow),
  font: Schema.Literals(KALUWA_STUDIO_FONTS),
});
export type KaluwaStudioDesign = typeof DesignSchema.Type;

const SettingsSchema = Schema.Struct({
  look: Schema.optionalKey(Schema.Unknown),
  tabs: Schema.optionalKey(Schema.Unknown),
  backdrop: Schema.optionalKey(Schema.Unknown),
  sidebar: Schema.optionalKey(Schema.Unknown),
});
/** Settings captured with a theme, as stored; kaluwaStudioActions.ts normalises each part. */
export type KaluwaStudioSettingsRaw = typeof SettingsSchema.Type;

const Name = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(48));

const StudioThemeSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^kaluwa-studio-[a-z0-9-]{1,56}$/)),
  name: Name,
  design: DesignSchema,
  settings: SettingsSchema,
});
export type KaluwaStudioTheme = typeof StudioThemeSchema.Type;

const decodeStudioTheme = Schema.decodeUnknownOption(StudioThemeSchema);

const KALUWA_STUDIO_FILE_KIND = "kaluwa-theme";
const KALUWA_STUDIO_FILE_VERSION = 1;

const FileSchema = Schema.Struct({
  kind: Schema.Literal(KALUWA_STUDIO_FILE_KIND),
  version: Schema.Literal(KALUWA_STUDIO_FILE_VERSION),
  name: Name,
  design: DesignSchema,
  settings: Schema.optionalKey(SettingsSchema),
  image: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String.check(Schema.isMaxLength(120)),
      dataUrl: Schema.String.check(
        Schema.isPattern(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/),
        Schema.isMaxLength(4_000_000),
      ),
    }),
  ),
});
export type KaluwaStudioFile = typeof FileSchema.Type;
export type KaluwaStudioImage = NonNullable<KaluwaStudioFile["image"]>;

const decodeFile = Schema.decodeUnknownSync(FileSchema);

function lowerColors(colors: KaluwaSchemeColors): KaluwaSchemeColors {
  const next: Record<string, string | number> = { ...colors };
  for (const key of KALUWA_STUDIO_COLOR_KEYS) next[key] = colors[key].toLowerCase();
  return next as KaluwaSchemeColors;
}

function normalizeDesign(design: KaluwaStudioDesign): KaluwaStudioDesign {
  return { ...design, dark: lowerColors(design.dark), light: lowerColors(design.light) };
}

/** A built-in preset's look as a design, with the composer radius the app draws today. */
export function designFromPreset(id: KaluwaPresetId): KaluwaStudioDesign {
  const preset = KALUWA_PRESETS[id];
  return {
    base: id,
    scheme: preset.scheme,
    dark: preset.dark,
    light: preset.light,
    warmth: 0,
    contrast: 0,
    radius: preset.radius,
    controlRadius: preset.controlRadius,
    composerRadius: Math.min(KALUWA_STUDIO_LIMITS.composerRadius[1], preset.radius + 8),
    shadow: 0,
    font: preset.font,
  };
}

/** Seeds a design from another theme's colours (any the theme lacks keep the preset's). */
export function designFromThemeColors(
  scheme: ThemeAppearance,
  colors: Readonly<Partial<Record<ThemeAppearance, Partial<KaluwaSchemeColors>>>>,
): KaluwaStudioDesign {
  const base = designFromPreset("today");
  return {
    ...base,
    scheme,
    dark: lowerColors({ ...base.dark, ...colors.dark }),
    light: lowerColors({ ...base.light, ...colors.light }),
  };
}

const clamp = (value: number, [min, max]: readonly [number, number]) =>
  Math.min(max, Math.max(min, value));

/** A scheme's colours with warmth and contrast applied, the way the theme lab derived them. */
export function effectiveSchemeColors(
  design: KaluwaStudioDesign,
  scheme: ThemeAppearance,
): KaluwaSchemeColors {
  const colors = design[scheme];
  const dark = scheme === "dark";
  const tint = design.warmth >= 0 ? "#ff9148" : "#3f7dff";
  const warmth = Math.abs(design.warmth) / 100;
  const warm = (color: string, weight: number) =>
    warmth === 0 ? color : mixHex(color, tint, warmth * weight);
  const surface = dark ? 0.09 : 0.07;
  const contrast = design.contrast / 100;
  const muted =
    contrast >= 0
      ? mixHex(colors.muted, colors.fg, contrast * 0.9)
      : mixHex(colors.muted, colors.bg, -contrast * 0.7);
  return {
    bg: warm(colors.bg, surface),
    chrome: warm(colors.chrome, surface),
    sidebar: warm(colors.sidebar, surface),
    card: warm(colors.card, surface),
    composer: warm(colors.composer, surface),
    fg: warm(colors.fg, 0.05),
    muted: warm(muted, 0.06),
    accent: colors.accent,
    accentFg: colors.accentFg,
    borderAlpha: Math.round(clamp(colors.borderAlpha * (1 + contrast * 1.6), [0, 60])),
  };
}

/** The preset a studio theme paints as: palette from its base, its own colours and shape. */
export function studioPreset(theme: KaluwaStudioTheme): KaluwaPreset {
  const { design } = theme;
  return {
    id: design.base,
    themeId: theme.id,
    scheme: design.scheme,
    radius: design.radius,
    controlRadius: design.controlRadius,
    font: design.font,
    dark: effectiveSchemeColors(design, "dark"),
    light: effectiveSchemeColors(design, "light"),
    composerRadius: design.composerRadius,
    shadow: design.shadow,
  };
}

export function studioThemeDefinition(
  theme: KaluwaStudioTheme,
  builders: KaluwaThemeBuilders,
): ThemeDefinition {
  return kaluwaPresetThemeDefinition(
    studioPreset(theme),
    { id: theme.id, label: theme.name },
    builders,
  );
}

/** `base`, or `base 2`, `base 3`… so names stay distinct in the theme library. */
export function uniqueStudioName(base: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((name) => name.trim().toLowerCase()));
  const trimmed = base.trim().slice(0, 44) || "Theme";
  if (!names.has(trimmed.toLowerCase())) return trimmed;
  for (let index = 2; ; index += 1) {
    const candidate = `${trimmed} ${index}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

export function studioThemeId(name: string, taken: Iterable<string>): string {
  const ids = new Set(taken);
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "theme";
  const base = `${KALUWA_STUDIO_THEME_PREFIX}${slug}`;
  if (!ids.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
}

export function createStudioTheme(
  input: Readonly<{ name: string; design: KaluwaStudioDesign; settings: KaluwaStudioSettingsRaw }>,
  existing: ReadonlyArray<KaluwaStudioTheme>,
  takenThemeIds: Iterable<string> = [],
): KaluwaStudioTheme {
  const name = uniqueStudioName(
    input.name,
    existing.map((theme) => theme.name),
  );
  return {
    id: studioThemeId(name, [...existing.map((theme) => theme.id), ...takenThemeIds]),
    name,
    design: normalizeDesign(input.design),
    settings: input.settings,
  };
}

/** Reads the stored library, dropping any entry that no longer validates. */
export function parseStudioLibrary(raw: string | null): ReadonlyArray<KaluwaStudioTheme> {
  let value: unknown = null;
  try {
    value = raw === null ? null : JSON.parse(raw);
  } catch {}
  const entries =
    typeof value === "object" && value !== null && "themes" in value && Array.isArray(value.themes)
      ? (value.themes as ReadonlyArray<unknown>)
      : [];
  const themes: KaluwaStudioTheme[] = [];
  for (const entry of entries) {
    const decoded = decodeStudioTheme(entry);
    if (decoded._tag === "None") continue;
    if (themes.some((theme) => theme.id === decoded.value.id)) continue;
    themes.push({ ...decoded.value, design: normalizeDesign(decoded.value.design) });
  }
  return themes;
}

export function serializeStudioLibrary(themes: ReadonlyArray<KaluwaStudioTheme>): string {
  return JSON.stringify({ version: 1, themes });
}

export function serializeStudioFile(
  theme: Readonly<{ name: string; design: KaluwaStudioDesign; settings: KaluwaStudioSettingsRaw }>,
  image?: KaluwaStudioImage,
): string {
  const file: KaluwaStudioFile = {
    kind: KALUWA_STUDIO_FILE_KIND,
    version: KALUWA_STUDIO_FILE_VERSION,
    name: theme.name,
    design: theme.design,
    settings: theme.settings,
    ...(image ? { image } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type StudioFileParseResult =
  | Readonly<{ ok: true; file: KaluwaStudioFile }>
  | Readonly<{
      ok: false;
      reason: "empty" | "json" | "kind" | "version" | "invalid";
      detail?: string;
    }>;

/** Validates pasted or opened theme JSON; the reason picks the message the studio shows. */
export function parseStudioFile(text: string): StudioFileParseResult {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "json" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "kind" };
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== KALUWA_STUDIO_FILE_KIND) return { ok: false, reason: "kind" };
  if (record.version !== KALUWA_STUDIO_FILE_VERSION) return { ok: false, reason: "version" };
  try {
    const file = decodeFile(value);
    return {
      ok: true,
      file: { ...file, name: file.name.trim(), design: normalizeDesign(file.design) },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n").slice(0, 4).join("\n") : "";
    return { ok: false, reason: "invalid", ...(detail ? { detail } : {}) };
  }
}
