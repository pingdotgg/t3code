import { DEFAULT_THEME_PALETTE, type ThemePaletteSettings } from "@t3tools/contracts/settings";

export const THEME_PALETTE_STORAGE_KEY = "t3code:client-settings:v1";

export const THEME_PALETTE_SWATCHES = [
  "#3b5bdb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
] as const;

export const THEME_PALETTE_PREVIEW_SWATCHES = [
  { label: "Primary", variable: "--primary" },
  { label: "Surface", variable: "--background" },
  { label: "Card", variable: "--card" },
  { label: "Muted", variable: "--muted" },
] as const;

const THEME_HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;
const THEME_PALETTE_CUSTOM_PROPERTIES = ["--theme-primary-seed", "--theme-neutral-seed"] as const;

export function normalizeThemePaletteColor(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !THEME_HEX_COLOR_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

export function normalizeThemePalette(
  value: Partial<ThemePaletteSettings> | null | undefined,
): ThemePaletteSettings {
  return {
    primaryColor:
      normalizeThemePaletteColor(value?.primaryColor) ?? DEFAULT_THEME_PALETTE.primaryColor,
    neutralColor:
      normalizeThemePaletteColor(value?.neutralColor) ?? DEFAULT_THEME_PALETTE.neutralColor,
  };
}

export function getThemePaletteCustomProperties(
  value: Partial<ThemePaletteSettings> | null | undefined,
) {
  const palette = normalizeThemePalette(value);
  return {
    "--theme-primary-seed": palette.primaryColor,
    "--theme-neutral-seed": palette.neutralColor,
  } as const;
}

export function applyThemePalette(value: Partial<ThemePaletteSettings> | null | undefined) {
  if (typeof document === "undefined") return;
  const properties = getThemePaletteCustomProperties(value);
  for (const propertyName of THEME_PALETTE_CUSTOM_PROPERTIES) {
    document.documentElement.style.setProperty(propertyName, properties[propertyName]);
  }
}

export function readStoredThemePalette(): ThemePaletteSettings {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return DEFAULT_THEME_PALETTE;
  }

  try {
    const raw = localStorage.getItem(THEME_PALETTE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_THEME_PALETTE;
    }
    const parsed = JSON.parse(raw) as { themePalette?: Partial<ThemePaletteSettings> };
    return normalizeThemePalette(parsed.themePalette);
  } catch {
    return DEFAULT_THEME_PALETTE;
  }
}

export function applyStoredThemePalette() {
  applyThemePalette(readStoredThemePalette());
}
