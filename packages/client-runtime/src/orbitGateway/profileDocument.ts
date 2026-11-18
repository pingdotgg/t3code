/**
 * The sections of an Orbit profile's settings document beyond `workspaces`, and guards for the
 * values a client reads from them. The Gateway checks the envelope and value types only; each
 * client validates the keys it understands and keeps the rest (see sectionMerge.ts).
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const PROFILE_SCHEMA_VERSION = 1;

/** Sections the Gateway accepts in a PATCH, besides `workspaces` (which keeps its own sync). */
export const APPEARANCE_SECTION = "appearance";
export const DESKTOP_DEVICE_SECTION = "devices.desktop";
const IPHONE_DEVICE_SECTION = "devices.iphone";

const PROFILE_SECTION_NAMES = [
  "workspaces",
  APPEARANCE_SECTION,
  DESKTOP_DEVICE_SECTION,
  IPHONE_DEVICE_SECTION,
  "sidebarHiddenThreads",
] as const;
export type ProfileSectionName = (typeof PROFILE_SECTION_NAMES)[number];

export type ProfileThemeAppearance = "light" | "dark";
export type ProfileAppearanceMode = ProfileThemeAppearance | "system";
export type ProfileThemeColors = Readonly<Record<string, string>>;

/** `stock` and `builtin` slots carry the id only; `custom` and `published` carry the resolved palette. */
export type ProfileThemeSlot =
  | { readonly id: string; readonly source: "stock" | "builtin" }
  | {
      readonly id: string;
      readonly name: string;
      readonly source: "custom" | "published";
      readonly appearance: ProfileThemeAppearance;
      readonly colors: ProfileThemeColors;
    };

export interface ProfileCustomTheme {
  readonly id: string;
  readonly name: string;
  readonly appearance: ProfileThemeAppearance;
  readonly colors: ProfileThemeColors;
  readonly variants?: Readonly<Partial<Record<ProfileThemeAppearance, ProfileThemeColors>>>;
  readonly collection?: { readonly id: string; readonly label: string };
}

export interface ProfileAppearance {
  readonly schema: number;
  readonly mode: ProfileAppearanceMode;
  readonly contrast: number;
  readonly themes: {
    readonly light: ProfileThemeSlot;
    readonly dark: ProfileThemeSlot;
  };
  readonly customThemes: readonly ProfileCustomTheme[];
}

/** A device type's settings: a flat key/value map. Unknown keys belong to other builds. */
export interface ProfileDeviceSection {
  readonly schema: number;
  readonly values: JsonObject;
}

/** Limits the Gateway enforces; clients stay under them instead of retrying a 422. */
export const PROFILE_LIMITS = {
  customThemes: 50,
  appearanceBytes: 512 * 1024,
  deviceBytes: 64 * 1024,
  deviceKeys: 128,
} as const;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeAppearance(value: unknown): value is ProfileThemeAppearance {
  return value === "light" || value === "dark";
}

function isColors(value: unknown): value is ProfileThemeColors {
  return isJsonObject(value) && Object.values(value).every((color) => typeof color === "string");
}

function isProfileThemeSlot(value: unknown): value is ProfileThemeSlot {
  if (!isJsonObject(value) || typeof value.id !== "string") return false;
  if (value.source === "stock" || value.source === "builtin") return true;
  return (
    (value.source === "custom" || value.source === "published") &&
    typeof value.name === "string" &&
    isThemeAppearance(value.appearance) &&
    isColors(value.colors)
  );
}

function isProfileCustomTheme(value: unknown): value is ProfileCustomTheme {
  if (!isJsonObject(value)) return false;
  if (typeof value.id !== "string" || typeof value.name !== "string") return false;
  if (!isThemeAppearance(value.appearance) || !isColors(value.colors)) return false;
  if (value.variants !== undefined) {
    if (!isJsonObject(value.variants)) return false;
    for (const [appearance, colors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(appearance) || !isColors(colors)) return false;
    }
  }
  return true;
}

/**
 * The appearance section when it has the shape this client understands, else null. A newer
 * `schema` is accepted: extra keys are ignored here and kept by the merge.
 */
export function parseProfileAppearance(value: unknown): ProfileAppearance | null {
  if (!isJsonObject(value) || typeof value.schema !== "number") return null;
  const { mode, contrast, themes, customThemes } = value;
  if (mode !== "light" && mode !== "dark" && mode !== "system") return null;
  if (typeof contrast !== "number" || !Number.isFinite(contrast)) return null;
  if (
    !isJsonObject(themes) ||
    !isProfileThemeSlot(themes.light) ||
    !isProfileThemeSlot(themes.dark)
  ) {
    return null;
  }
  if (!Array.isArray(customThemes)) return null;
  return {
    schema: value.schema,
    mode,
    contrast,
    themes: { light: themes.light, dark: themes.dark },
    // A malformed library entry is skipped; it must not discard the whole appearance.
    customThemes: customThemes.filter(isProfileCustomTheme),
  };
}

export function parseProfileDeviceSection(value: unknown): ProfileDeviceSection | null {
  if (!isJsonObject(value) || typeof value.schema !== "number" || !isJsonObject(value.values)) {
    return null;
  }
  return { schema: value.schema, values: value.values };
}
