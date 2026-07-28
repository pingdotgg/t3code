import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_FONT_FAMILY,
  MAX_FONT_FAMILY_LENGTH,
} from "@t3tools/contracts/settings";

export type FontPreferenceKind = "ui" | "code";

export type FontPresetId = "default" | "system" | "geist" | "inter" | "jetbrains" | "custom";

export interface FontPresetOption {
  readonly id: Exclude<FontPresetId, "custom">;
  readonly label: string;
  /** Stored preference value. Empty string means bundled default. */
  readonly value: string;
}

const SANS_FALLBACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

const CSS_FONT_KEYWORDS = new Set([
  "caption",
  "icon",
  "menu",
  "message-box",
  "mono",
  "monospace",
  "sans-serif",
  "serif",
  "small-caps",
  "status-bar",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

export const UI_FONT_PRESETS: ReadonlyArray<FontPresetOption> = [
  { id: "default", label: "Default (DM Sans)", value: DEFAULT_UI_FONT_FAMILY },
  { id: "system", label: "System UI", value: "system-ui" },
  { id: "geist", label: "Geist", value: "Geist" },
  { id: "inter", label: "Inter", value: "Inter" },
];

export const CODE_FONT_PRESETS: ReadonlyArray<FontPresetOption> = [
  { id: "default", label: "Default", value: DEFAULT_CODE_FONT_FAMILY },
  { id: "system", label: "System Mono", value: "ui-monospace" },
  { id: "geist", label: "Geist Mono", value: "Geist Mono" },
  { id: "jetbrains", label: "JetBrains Mono", value: "JetBrains Mono" },
];

const UNSAFE_FONT_FAMILY_PATTERN = /[;{}()\\]|url\s*\(/i;

export function sanitizeFontFamilyPreference(raw: string): string {
  const trimmed = raw.trim().replace(/^["']+|["']+$/g, "");
  if (!trimmed || trimmed.length > MAX_FONT_FAMILY_LENGTH) {
    return "";
  }
  if (UNSAFE_FONT_FAMILY_PATTERN.test(trimmed)) {
    return "";
  }
  return trimmed;
}

export function matchFontPresetId(value: string, kind: FontPreferenceKind): FontPresetId {
  const presets = kind === "ui" ? UI_FONT_PRESETS : CODE_FONT_PRESETS;
  const matched = presets.find((preset) => preset.value === value);
  if (matched) {
    return matched.id;
  }
  return value ? "custom" : "default";
}

export function quoteCssFontFamily(family: string): string {
  if (CSS_FONT_KEYWORDS.has(family.toLowerCase())) {
    return family;
  }
  if (/^[\w-]+$/.test(family)) {
    return family;
  }
  return `"${family.replaceAll('"', '\\"')}"`;
}

/**
 * Resolve a stored preference into a CSS `font-family` value.
 * Returns `null` when the bundled default should remain (no inline override).
 */
export function resolveFontFamilyCss(preference: string, kind: FontPreferenceKind): string | null {
  const sanitized = sanitizeFontFamilyPreference(preference);
  if (!sanitized) {
    return null;
  }

  const fallback = kind === "ui" ? SANS_FALLBACK : MONO_FALLBACK;
  return `${quoteCssFontFamily(sanitized)}, ${fallback}`;
}

export function applyFontFamilyPreference(
  preference: string,
  kind: FontPreferenceKind,
  target: CSSStyleDeclaration = document.documentElement.style,
): void {
  const cssVariable = kind === "ui" ? "--font-sans" : "--font-mono";
  const resolved = resolveFontFamilyCss(preference, kind);
  if (resolved === null) {
    target.removeProperty(cssVariable);
    return;
  }
  target.setProperty(cssVariable, resolved);
}
