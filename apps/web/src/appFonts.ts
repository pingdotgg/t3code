const SYSTEM_FONT_CACHE_KEY = "t3code:system-font-families:v1";
const MAX_SYSTEM_FONT_FAMILY_COUNT = 512;
export const MAX_APP_FONT_FAMILY_LENGTH = 512;

export const DEFAULT_APP_FONT_FAMILIES = {
  interfaceFontFamily:
    '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  headingFontFamily:
    '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  monoFontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
} as const;

const SYSTEM_FONT_FAMILY_PRESETS = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
} as const;

export const APP_FONT_ROLE_DEFINITIONS = [
  {
    key: "interfaceFontFamily",
    label: "Interface",
    description: "Used for body copy, labels, buttons, and most app chrome.",
    sampleText: "Aa Bb Cc 012345 The quick brown fox jumps over the lazy dog.",
    fallbackKind: "sans",
  },
  {
    key: "headingFontFamily",
    label: "Headings",
    description: "Used for page titles, section headings, dialogs, and display text.",
    sampleText: "Design the shape of the workspace.",
    fallbackKind: "sans",
  },
  {
    key: "monoFontFamily",
    label: "Monospace",
    description: "Used for code, paths, inputs, and the terminal. Pick a monospace family here.",
    sampleText: '{} => const file = "/src/index.ts"; ls -la',
    fallbackKind: "mono",
  },
] as const;

export type AppFontSettingKey = (typeof APP_FONT_ROLE_DEFINITIONS)[number]["key"];
export type AppFontFallbackKind = (typeof APP_FONT_ROLE_DEFINITIONS)[number]["fallbackKind"];

export interface AppFontOption {
  value: string;
  label: string;
  previewFontFamily: string;
  source: "default" | "system" | "current";
}

function normalizeStoredFontFamily(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_APP_FONT_FAMILY_LENGTH) {
    return fallback;
  }
  return trimmed;
}

function quoteFontFamily(family: string): string {
  return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemFontValue(family: string, fallbackKind: AppFontFallbackKind): string {
  const fallback =
    fallbackKind === "mono" ? SYSTEM_FONT_FAMILY_PRESETS.mono : SYSTEM_FONT_FAMILY_PRESETS.sans;
  return `${quoteFontFamily(family)}, ${fallback}`;
}

export function normalizeAppFontSetting(
  key: AppFontSettingKey,
  value: string | null | undefined,
): string {
  return normalizeStoredFontFamily(value, DEFAULT_APP_FONT_FAMILIES[key]);
}

export function normalizeSystemFontFamilies(
  families: Iterable<string | null | undefined>,
): string[] {
  const deduped = new Set<string>();

  for (const family of families) {
    const trimmed = family?.trim();
    if (!trimmed) {
      continue;
    }
    deduped.add(trimmed);
    if (deduped.size >= MAX_SYSTEM_FONT_FAMILY_COUNT) {
      break;
    }
  }

  return [...deduped].toSorted((left, right) => left.localeCompare(right));
}

function fontLabelFromValue(value: string): string {
  const [firstSegment = value] = value.split(",", 1);
  const normalized = firstSegment.trim().replace(/^['"]|['"]$/g, "");
  return normalized.length > 0 ? normalized : "Current selection";
}

export function getAppFontOptions(
  key: AppFontSettingKey,
  systemFontFamilies: readonly string[],
  selectedValue?: string | null,
): AppFontOption[] {
  const role = APP_FONT_ROLE_DEFINITIONS.find((definition) => definition.key === key);
  if (!role) {
    return [];
  }

  const options: AppFontOption[] = [
    {
      value: DEFAULT_APP_FONT_FAMILIES[key],
      label: key === "monoFontFamily" ? "T3 Code Mono" : "T3 Code Sans",
      previewFontFamily: DEFAULT_APP_FONT_FAMILIES[key],
      source: "default",
    },
    {
      value:
        role.fallbackKind === "mono"
          ? SYSTEM_FONT_FAMILY_PRESETS.mono
          : SYSTEM_FONT_FAMILY_PRESETS.sans,
      label: role.fallbackKind === "mono" ? "System Mono" : "System UI",
      previewFontFamily:
        role.fallbackKind === "mono"
          ? SYSTEM_FONT_FAMILY_PRESETS.mono
          : SYSTEM_FONT_FAMILY_PRESETS.sans,
      source: "default",
    },
  ];
  const seen = new Set(options.map((option) => option.value));

  for (const family of normalizeSystemFontFamilies(systemFontFamilies)) {
    const value = systemFontValue(family, role.fallbackKind);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    options.push({
      value,
      label: family,
      previewFontFamily: value,
      source: "system",
    });
  }

  const normalizedSelectedValue = normalizeAppFontSetting(key, selectedValue);
  if (!seen.has(normalizedSelectedValue)) {
    options.push({
      value: normalizedSelectedValue,
      label: fontLabelFromValue(normalizedSelectedValue),
      previewFontFamily: normalizedSelectedValue,
      source: "current",
    });
  }

  return options;
}

export function getCachedSystemFontFamilies(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(SYSTEM_FONT_CACHE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? normalizeSystemFontFamilies(parsed) : [];
  } catch {
    return [];
  }
}

function persistSystemFontFamilies(families: readonly string[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      SYSTEM_FONT_CACHE_KEY,
      JSON.stringify(normalizeSystemFontFamilies(families)),
    );
  } catch {
    // Best-effort cache only.
  }
}

export function supportsSystemFontAccess(): boolean {
  return typeof window !== "undefined" && typeof window.queryLocalFonts === "function";
}

export async function requestSystemFontFamilies(): Promise<string[]> {
  const queryLocalFonts = window.queryLocalFonts;
  if (typeof queryLocalFonts !== "function") {
    throw new Error("System font access is not available in this browser.");
  }

  const fonts = await queryLocalFonts.call(window);
  const families = normalizeSystemFontFamilies(fonts.map((font) => font.family));
  persistSystemFontFamilies(families);
  return families;
}

export function applyAppFontSettings(settings: {
  interfaceFontFamily: string;
  headingFontFamily: string;
  monoFontFamily: string;
}): void {
  if (typeof document === "undefined") {
    return;
  }

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty(
    "--app-font-sans",
    normalizeAppFontSetting("interfaceFontFamily", settings.interfaceFontFamily),
  );
  rootStyle.setProperty(
    "--app-font-heading",
    normalizeAppFontSetting("headingFontFamily", settings.headingFontFamily),
  );
  rootStyle.setProperty(
    "--app-font-mono",
    normalizeAppFontSetting("monoFontFamily", settings.monoFontFamily),
  );
}
