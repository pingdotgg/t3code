import {
  DEFAULT_CODE_FONT_SIZE_PX,
  DEFAULT_MAC_OS_FONT_SMOOTHING,
  DEFAULT_UI_FONT_SIZE_PX,
  MAX_INTERFACE_FONT_SIZE_PX,
  MIN_INTERFACE_FONT_SIZE_PX,
  type MacOsFontSmoothing,
  type CodeFontSizePx,
  type UiFontSizePx,
} from "@forma/contracts/settings";

export interface InterfaceAppearanceSettings {
  uiFontScale?: UiFontSizePx | null | undefined;
  codeFontScale?: CodeFontSizePx | null | undefined;
  macOsFontSmoothing?: MacOsFontSmoothing | null | undefined;
}

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
}
