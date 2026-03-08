export const DEFAULT_ACCENT_COLOR = "#2563eb";

export const ACCENT_COLOR_PRESETS = [
  { label: "Blue", value: "#2563eb" },
  { label: "Emerald", value: "#059669" },
  { label: "Amber", value: "#d97706" },
  { label: "Rose", value: "#e11d48" },
  { label: "Violet", value: "#7c3aed" },
] as const;

const HEX_COLOR_PATTERN = /^#(?<value>[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeAccentColor(value: string | null | undefined): string {
  const trimmedValue = value?.trim() ?? "";
  const parsed = HEX_COLOR_PATTERN.exec(trimmedValue);
  if (!parsed) {
    return DEFAULT_ACCENT_COLOR;
  }

  const hexValue = parsed.groups?.value?.toLowerCase() ?? "";
  if (hexValue.length === 3) {
    const [r, g, b] = hexValue;
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  return `#${hexValue}`;
}

/**
 * Returns true when `value` is a syntactically valid hex accent color
 * (3- or 6-digit hex with leading `#`). Unlike `normalizeAccentColor`,
 * this does not substitute a default for invalid values.
 */
export function isValidAccentColor(value: string | null | undefined): boolean {
  return HEX_COLOR_PATTERN.test(value?.trim() ?? "");
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = normalizeAccentColor(color);
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function clampChannel(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${clampChannel(r).toString(16).padStart(2, "0")}${clampChannel(g).toString(16).padStart(2, "0")}${clampChannel(b).toString(16).padStart(2, "0")}`;
}

function toLinearChannel(channel: number): number {
  const normalized = channel / 255;
  if (normalized <= 0.04045) {
    return normalized / 12.92;
  }
  return ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const rgb = hexToRgb(color);
  return (
    0.2126 * toLinearChannel(rgb.r) +
    0.7152 * toLinearChannel(rgb.g) +
    0.0722 * toLinearChannel(rgb.b)
  );
}

export function contrastRatio(a: string, b: string): number {
  const lumA = relativeLuminance(a);
  const lumB = relativeLuminance(b);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA minimum contrast ratio for normal text. */
const WCAG_AA_CONTRAST_THRESHOLD = 4.5;

/**
 * Returns the foreground color that provides the best contrast against the
 * given accent color, or `null` if neither white nor dark text can achieve
 * the WCAG AA contrast threshold (4.5:1).
 */
export function resolveAccentForegroundColor(color: string): "#ffffff" | "#111827" | null {
  const normalized = normalizeAccentColor(color);
  const whiteContrast = contrastRatio(normalized, "#ffffff");
  const darkContrast = contrastRatio(normalized, "#111827");
  const bestContrast = Math.max(whiteContrast, darkContrast);
  if (bestContrast < WCAG_AA_CONTRAST_THRESHOLD) {
    return null;
  }
  return darkContrast > whiteContrast ? "#111827" : "#ffffff";
}

export function resolveAccentColorRgba(color: string, alpha: number): string {
  const rgb = hexToRgb(color);
  const safeAlpha = Number.isFinite(alpha) ? Math.min(Math.max(alpha, 0), 1) : 1;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${safeAlpha})`;
}

/** Minimum contrast ratio for terminal text against its background. */
const TERMINAL_MIN_CONTRAST = 3.0;

/**
 * Returns a variant of `accent` guaranteed to have at least
 * `TERMINAL_MIN_CONTRAST` (3:1) against `background`. If the raw accent
 * already passes, it is returned unchanged. Otherwise it is progressively
 * mixed toward white (dark backgrounds) or black (light backgrounds) until
 * the threshold is met.
 */
export function contrastSafeTerminalColor(accent: string, background: string): string {
  const normalized = normalizeAccentColor(accent);
  if (contrastRatio(normalized, background) >= TERMINAL_MIN_CONTRAST) {
    return normalized;
  }

  const bgLum = relativeLuminance(background);
  const accentRgb = hexToRgb(normalized);
  // Mix toward white for dark backgrounds, toward black for light ones.
  const targetR = bgLum < 0.5 ? 255 : 0;
  const targetG = bgLum < 0.5 ? 255 : 0;
  const targetB = bgLum < 0.5 ? 255 : 0;

  // Binary search for the minimum mix ratio that achieves the threshold.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const r = accentRgb.r + (targetR - accentRgb.r) * mid;
    const g = accentRgb.g + (targetG - accentRgb.g) * mid;
    const b = accentRgb.b + (targetB - accentRgb.b) * mid;
    const candidate = rgbToHex(r, g, b);
    if (contrastRatio(candidate, background) >= TERMINAL_MIN_CONTRAST) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  const r = accentRgb.r + (targetR - accentRgb.r) * hi;
  const g = accentRgb.g + (targetG - accentRgb.g) * hi;
  const b = accentRgb.b + (targetB - accentRgb.b) * hi;
  return rgbToHex(r, g, b);
}

export function applyAccentColorToDocument(color: string): void {
  if (typeof document === "undefined") {
    return;
  }

  const normalized = normalizeAccentColor(color);
  const foreground = resolveAccentForegroundColor(normalized);

  // If the accent has insufficient contrast with both white and dark text,
  // fall back to the default accent color which is known to be safe.
  const effectiveColor = foreground !== null ? normalized : DEFAULT_ACCENT_COLOR;
  const effectiveForeground =
    foreground ?? (resolveAccentForegroundColor(DEFAULT_ACCENT_COLOR) as "#ffffff" | "#111827");

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--accent-color", effectiveColor);
  rootStyle.setProperty("--accent-color-foreground", effectiveForeground);
}
