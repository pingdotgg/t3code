import {
  getDefaultThemeColors,
  parseThemeSource,
  resolveThemeSource,
  toCanonicalThemeColor,
} from "@t3tools/shared/themeResolution";
import {
  RESERVED_THEME_IDS,
  THEME_COLOR_ROLES,
  DEPRECATED_THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariants,
} from "@t3tools/shared/themePalettes";
export type ThemeCollection = Readonly<{ id: string; label: string }>;
export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>;
const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

export function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

export function parseThemeCollection(value: unknown): ThemeCollection | undefined {
  return isRecord(value) &&
    typeof value.id === "string" &&
    /^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id) &&
    isThemeLabel(value.label)
    ? { id: value.id, label: value.label.trim() }
    : undefined;
}

export function lenientThemeColorOverrides(
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

export function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null;
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null;
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null;
  const colors = parseStoredThemeColors(value.colors, value.appearance);
  if (!colors && value.sources === undefined) return null;
  const variants = parseStoredThemeVariants(value.variants, value.appearance);
  if (value.variants !== undefined && variants === null) return null;
  const collection = parseThemeCollection(value.collection);
  if (value.sources !== undefined && value.collection !== undefined && !collection) return null;
  const sources: NonNullable<ThemeDefinition["sources"]> = {};
  if (value.sources !== undefined) {
    if (!isRecord(value.sources)) return null;
    try {
      if (value.colors !== undefined) parseThemeColorOverrides(value.colors);
      if (value.variants !== undefined) {
        if (!isRecord(value.variants)) return null;
        for (const [mode, cache] of Object.entries(value.variants)) {
          if (!isThemeAppearance(mode) || mode === value.appearance) return null;
          parseThemeColorOverrides(cache);
        }
      }
    } catch {
      return null;
    }
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

  if (value.sources !== undefined && !sources[value.appearance]) return null;
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
      : colors!,
    ...(value.sources === undefined ? {} : { sources }),
    ...(Object.keys(resolvedVariants).length ? { variants: resolvedVariants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export function parseThemeColorOverrides(value: unknown): ThemeColorOverrides {
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
