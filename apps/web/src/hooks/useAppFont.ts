import { useEffect } from "react";
import {
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CODE_FONT,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_TOOL_FONT_SIZE,
  DEFAULT_UI_DENSITY,
  DEFAULT_UI_FONT,
  type CodeFont,
  type FontSize,
  type UiDensity,
  type UiFont,
} from "@t3tools/contracts/settings";

import { readBrowserClientSettings } from "../clientPersistenceStorage";
import { useSettings } from "./useSettings";

const APP_FONT_ATTRIBUTE = "data-ui-font";
const CODE_FONT_ATTRIBUTE = "data-code-font";

export const CODE_FONT_STACKS: Record<CodeFont, string> = {
  "system-mono":
    '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
  "sf-mono":
    '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
  menlo:
    'Menlo, Monaco, "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", ui-monospace, monospace',
  "jetbrains-mono":
    '"JetBrains Mono", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
};

function normalizeUiFont(value: unknown): UiFont {
  return value === "geist" || value === "dm-sans" ? value : DEFAULT_UI_FONT;
}

function normalizeCodeFont(value: unknown): CodeFont {
  return value === "system-mono" ||
    value === "sf-mono" ||
    value === "menlo" ||
    value === "jetbrains-mono"
    ? value
    : DEFAULT_CODE_FONT;
}

function normalizeFontSize(value: unknown, fallback: FontSize): FontSize {
  if (typeof value === "number" && Number.isInteger(value) && value >= 6 && value <= 24) {
    return value as FontSize;
  }
  return fallback;
}

export function applyAppFont(font: UiFont): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute(APP_FONT_ATTRIBUTE, font);
}

export function applyCodeFont(font: CodeFont): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute(CODE_FONT_ATTRIBUTE, font);
}

export function applyFontSizes(
  codeFontSize: FontSize,
  chatFontSize: FontSize,
  toolFontSize: FontSize,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const style = document.documentElement.style;
  style.setProperty("--app-code-font-size", `${codeFontSize}px`);
  style.setProperty("--app-chat-font-size", `${chatFontSize}px`);
  style.setProperty("--app-tool-font-size", `${toolFontSize}px`);
}

export function applyUiDensity(density: UiDensity): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute("data-ui-density", density);
}

function normalizeUiDensity(value: unknown): UiDensity {
  return value === "compact" || value === "default" || value === "spacious"
    ? value
    : DEFAULT_UI_DENSITY;
}

function getStoredUiFont(): UiFont {
  return normalizeUiFont(readBrowserClientSettings()?.uiFont);
}

function getStoredCodeFont(): CodeFont {
  return normalizeCodeFont(readBrowserClientSettings()?.codeFont);
}

function getStoredFontSizes(): {
  codeFontSize: FontSize;
  chatFontSize: FontSize;
  toolFontSize: FontSize;
} {
  const stored = readBrowserClientSettings();
  return {
    codeFontSize: normalizeFontSize(stored?.codeFontSize, DEFAULT_CODE_FONT_SIZE),
    chatFontSize: normalizeFontSize(stored?.chatFontSize, DEFAULT_CHAT_FONT_SIZE),
    toolFontSize: normalizeFontSize(stored?.toolFontSize, DEFAULT_TOOL_FONT_SIZE),
  };
}

if (typeof document !== "undefined") {
  applyAppFont(getStoredUiFont());
  applyCodeFont(getStoredCodeFont());
  applyUiDensity(normalizeUiDensity(readBrowserClientSettings()?.uiDensity));
  const sizes = getStoredFontSizes();
  applyFontSizes(sizes.codeFontSize, sizes.chatFontSize, sizes.toolFontSize);
}

export function useAppFont() {
  const uiFont = useSettings((settings) => settings.uiFont);
  const codeFont = useSettings((settings) => settings.codeFont);
  const codeFontSize = useSettings((settings) => settings.codeFontSize);
  const chatFontSize = useSettings((settings) => settings.chatFontSize);
  const toolFontSize = useSettings((settings) => settings.toolFontSize);
  const uiDensity = useSettings((settings) => settings.uiDensity);

  useEffect(() => {
    applyAppFont(uiFont);
  }, [uiFont]);

  useEffect(() => {
    applyCodeFont(codeFont);
  }, [codeFont]);

  useEffect(() => {
    applyFontSizes(codeFontSize, chatFontSize, toolFontSize);
  }, [codeFontSize, chatFontSize, toolFontSize]);

  useEffect(() => {
    applyUiDensity(uiDensity);
  }, [uiDensity]);

  return { uiFont, codeFont, codeFontSize, chatFontSize, toolFontSize, uiDensity };
}
