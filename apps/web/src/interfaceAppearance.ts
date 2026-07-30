// Forma interface appearance: custom UI/code font sizing and macOS font
// smoothing. The fork originally persisted these through the settings
// contracts (@t3tools/contracts/settings); the current upstream contracts do
// not carry these fields, so the constants live here and preferences persist
// to localStorage until the contract fields are re-added.

export type MacOsFontSmoothing = "auto" | "grayscale";
export type UiFontSizePx = number;
export type CodeFontSizePx = number;

export const MIN_INTERFACE_FONT_SIZE_PX = 8;
export const MAX_INTERFACE_FONT_SIZE_PX = 32;
export const DEFAULT_UI_FONT_SIZE_PX: UiFontSizePx = 16;
export const DEFAULT_CODE_FONT_SIZE_PX: CodeFontSizePx = 14;
export const DEFAULT_MAC_OS_FONT_SMOOTHING: MacOsFontSmoothing = "auto";

export const INTERFACE_APPEARANCE_STORAGE_KEY = "forma:interface-appearance";
export const INTERFACE_APPEARANCE_CHANGED_EVENT = "forma:interface-appearance-changed";

/**
 * Subscribe to appearance changes applied via
 * `applyInterfaceSettingsToDocument`. Used by consumers that need a JS value
 * (e.g. the terminal's xterm font size) rather than a CSS variable.
 */
export function subscribeToInterfaceAppearanceChanges(listener: () => void): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }
  document.addEventListener(INTERFACE_APPEARANCE_CHANGED_EVENT, listener);
  return () => document.removeEventListener(INTERFACE_APPEARANCE_CHANGED_EVENT, listener);
}

export interface InterfaceAppearanceSettings {
  uiFontScale?: UiFontSizePx | null | undefined;
  codeFontScale?: CodeFontSizePx | null | undefined;
  macOsFontSmoothing?: MacOsFontSmoothing | null | undefined;
}

type InterfaceAppearanceStorageLike = Pick<Storage, "getItem" | "setItem">;

function clampInterfaceFontSize(value: number): number {
  return Math.max(
    MIN_INTERFACE_FONT_SIZE_PX,
    Math.min(MAX_INTERFACE_FONT_SIZE_PX, Math.round(value)),
  );
}

function formatPx(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}px`;
}

export function resolveUiFontSizePx(value?: UiFontSizePx | null): UiFontSizePx {
  return clampInterfaceFontSize(value ?? DEFAULT_UI_FONT_SIZE_PX) as UiFontSizePx;
}

export function resolveCodeFontSizePx(value?: CodeFontSizePx | null): CodeFontSizePx {
  return clampInterfaceFontSize(value ?? DEFAULT_CODE_FONT_SIZE_PX) as CodeFontSizePx;
}

export function resolveMacOsFontSmoothing(value?: MacOsFontSmoothing | null): MacOsFontSmoothing {
  return value ?? DEFAULT_MAC_OS_FONT_SMOOTHING;
}

export function getCodeEditorFontSize(value?: CodeFontSizePx | null): number {
  return resolveCodeFontSizePx(value);
}

export function getCodeTerminalFontSize(value?: CodeFontSizePx | null): number {
  return Math.max(MIN_INTERFACE_FONT_SIZE_PX, resolveCodeFontSizePx(value) - 2);
}

function parseStoredFontSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return clampInterfaceFontSize(value);
}

export function readStoredInterfaceAppearanceSettings(
  storage?: InterfaceAppearanceStorageLike | null,
): InterfaceAppearanceSettings {
  const targetStorage =
    storage ??
    (typeof localStorage !== "undefined" ? (localStorage as InterfaceAppearanceStorageLike) : null);
  if (!targetStorage) {
    return {};
  }

  let raw: string | null;
  try {
    raw = targetStorage.getItem(INTERFACE_APPEARANCE_STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const candidate = parsed as Record<string, unknown>;
    const settings: InterfaceAppearanceSettings = {};
    const uiFontScale = parseStoredFontSize(candidate.uiFontScale);
    if (uiFontScale !== null) {
      settings.uiFontScale = uiFontScale;
    }
    const codeFontScale = parseStoredFontSize(candidate.codeFontScale);
    if (codeFontScale !== null) {
      settings.codeFontScale = codeFontScale;
    }
    if (candidate.macOsFontSmoothing === "auto" || candidate.macOsFontSmoothing === "grayscale") {
      settings.macOsFontSmoothing = candidate.macOsFontSmoothing;
    }
    return settings;
  } catch {
    return {};
  }
}

export function writeStoredInterfaceAppearanceSettings(
  settings: InterfaceAppearanceSettings,
  storage?: InterfaceAppearanceStorageLike | null,
): void {
  const targetStorage =
    storage ??
    (typeof localStorage !== "undefined" ? (localStorage as InterfaceAppearanceStorageLike) : null);
  if (!targetStorage) {
    return;
  }
  try {
    targetStorage.setItem(
      INTERFACE_APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        uiFontScale: resolveUiFontSizePx(settings.uiFontScale),
        codeFontScale: resolveCodeFontSizePx(settings.codeFontScale),
        macOsFontSmoothing: resolveMacOsFontSmoothing(settings.macOsFontSmoothing),
      }),
    );
  } catch {
    // Persisting appearance preferences is best-effort.
  }
}

export function applyInterfaceSettingsToDocument(
  settings: InterfaceAppearanceSettings,
  targetDocument?: Document | null,
): void {
  const safeDocument = targetDocument ?? (typeof document !== "undefined" ? document : null);
  if (!safeDocument) {
    return;
  }

  const root = safeDocument.documentElement;
  const uiFontSizePx = resolveUiFontSizePx(settings.uiFontScale);
  const codeFontSizePx = resolveCodeFontSizePx(settings.codeFontScale);
  const macOsFontSmoothing = resolveMacOsFontSmoothing(settings.macOsFontSmoothing);

  root.dataset.uiFontScale = String(uiFontSizePx);
  root.dataset.codeFontScale = String(codeFontSizePx);
  root.dataset.fontSmoothing = macOsFontSmoothing;

  root.style.setProperty("--app-ui-root-font-size", formatPx(uiFontSizePx));
  root.style.setProperty("--app-ui-text-2xs", formatPx(uiFontSizePx - 5.5));
  root.style.setProperty("--app-ui-text-xs", formatPx(uiFontSizePx - 4.5));
  root.style.setProperty("--app-ui-text-sm", formatPx(uiFontSizePx - 2.5));
  root.style.setProperty(
    "--app-code-font-size",
    formatPx(Math.max(MIN_INTERFACE_FONT_SIZE_PX, codeFontSizePx - 2)),
  );
  root.style.setProperty(
    "--app-code-font-size-compact",
    formatPx(Math.max(MIN_INTERFACE_FONT_SIZE_PX, codeFontSizePx - 3)),
  );
  // Code editor / diff pane body text. Offset so the default (14px) matches
  // the @pierre/diffs default of 13px, then scales with the user preference.
  root.style.setProperty(
    "--app-code-editor-font-size",
    formatPx(Math.max(MIN_INTERFACE_FONT_SIZE_PX, getCodeEditorFontSize(codeFontSizePx) - 1)),
  );

  switch (macOsFontSmoothing) {
    case "grayscale":
      root.style.setProperty("-webkit-font-smoothing", "antialiased");
      root.style.setProperty("-moz-osx-font-smoothing", "grayscale");
      break;
    case "auto":
      root.style.removeProperty("-webkit-font-smoothing");
      root.style.removeProperty("-moz-osx-font-smoothing");
      break;
  }

  if (typeof CustomEvent !== "undefined" && typeof safeDocument.dispatchEvent === "function") {
    safeDocument.dispatchEvent(new CustomEvent(INTERFACE_APPEARANCE_CHANGED_EVENT));
  }
}
