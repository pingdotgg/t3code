import { registerCustomTheme } from "@pierre/diffs";

import {
  getThemeDefinition,
  notifyThemePreview,
  THEME_PREVIEW_ID,
  type ThemeAppearance,
} from "../themePalette";
import { toShikiThemeJson, type VsCodeSyntaxTheme } from "../themeSyntax";

export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export type DiffThemeName = string;

const registeredSyntaxFingerprints = new Map<string, string>();
const previewSyntax = new Map<ThemeAppearance, VsCodeSyntaxTheme>();

function fingerprintSyntax(syntax: VsCodeSyntaxTheme): string {
  let hash = 0x811c9dc5;
  const input = JSON.stringify(syntax);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function bundledThemeName(appearance: ThemeAppearance): (typeof DIFF_THEME_NAMES)[ThemeAppearance] {
  return appearance === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

function lookupSyntax(themeId: string, appearance: ThemeAppearance): VsCodeSyntaxTheme | undefined {
  if (themeId === THEME_PREVIEW_ID) return previewSyntax.get(appearance);
  return getThemeDefinition(themeId)?.syntax?.[appearance];
}

/**
 * Registers a VS Code `tokenColors` payload for Shiki. Pierre refuses to
 * overwrite a name, so a content fingerprint is appended when the payload
 * changes after the first registration.
 */
export function ensureRegisteredSyntaxTheme(
  themeId: string,
  appearance: ThemeAppearance,
  syntax: VsCodeSyntaxTheme,
): string {
  const fingerprint = fingerprintSyntax(syntax);
  const logicalName = `t3-syntax-${themeId}-${appearance}`;
  const registeredFingerprint = registeredSyntaxFingerprints.get(logicalName);
  const name =
    registeredFingerprint === undefined || registeredFingerprint === fingerprint
      ? logicalName
      : `${logicalName}-${fingerprint}`;

  if (!registeredSyntaxFingerprints.has(name)) {
    const json = toShikiThemeJson(name, appearance, syntax);
    registerCustomTheme(name, async () => json);
    registeredSyntaxFingerprints.set(name, fingerprint);
    if (name === logicalName) registeredSyntaxFingerprints.set(logicalName, fingerprint);
  }
  return name;
}

export function applySyntaxThemePreview(
  syntax: VsCodeSyntaxTheme | undefined,
  appearance: ThemeAppearance,
): void {
  if (syntax) previewSyntax.set(appearance, syntax);
  else previewSyntax.delete(appearance);
  notifyThemePreview();
}

export function getPreviewSyntax(appearance: ThemeAppearance): VsCodeSyntaxTheme | undefined {
  return previewSyntax.get(appearance);
}

/**
 * Shiki theme for diffs and code blocks. Custom `tokenColors` register as
 * `t3-syntax-<themeId>-<appearance>`; themes without a payload keep Pierre.
 */
export function resolveDiffThemeName(
  themeId: string | null | undefined,
  appearance: ThemeAppearance,
): DiffThemeName {
  const fallback = bundledThemeName(appearance);
  if (!themeId) return fallback;
  const syntax = lookupSyntax(themeId, appearance);
  if (!syntax) return fallback;
  return ensureRegisteredSyntaxTheme(themeId, appearance, syntax);
}
