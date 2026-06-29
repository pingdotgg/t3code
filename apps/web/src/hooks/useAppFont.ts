import { useEffect } from "react";
import {
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CODE_FONT,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INPUT_FONT_SIZE,
  DEFAULT_SIDEBAR_TRANSLUCENCY,
  DEFAULT_SIDEBAR_FONT_SIZE,
  DEFAULT_TOOL_FONT_SIZE,
  DEFAULT_UI_DENSITY,
  DEFAULT_UI_FONT,
  type CodeFont,
  type FontSize,
  type SidebarTranslucency,
  type UiDensity,
  type UiFont,
} from "@t3tools/contracts/settings";

import { readBrowserClientSettings } from "../clientPersistenceStorage";
import { useSettings } from "./useSettings";
import { syncBrowserChromeTheme } from "./useTheme";

const APP_FONT_ATTRIBUTE = "data-ui-font";
const CODE_FONT_ATTRIBUTE = "data-code-font";
const SIDEBAR_TRANSLUCENCY_ATTRIBUTE = "data-sidebar-translucency";
const NATIVE_VIBRANCY_ATTRIBUTE = "data-native-vibrancy";
const WINDOW_FOCUSED_ATTRIBUTE = "data-window-focused";
let nativeVibrancyRequestId = 0;

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

export function applyFontSizes(sizes: {
  codeFontSize: FontSize;
  chatFontSize: FontSize;
  sidebarFontSize: FontSize;
  toolFontSize: FontSize;
  inputFontSize: FontSize;
}): void {
  if (typeof document === "undefined") {
    return;
  }

  const style = document.documentElement.style;
  style.setProperty("--app-code-font-size", `${sizes.codeFontSize}px`);
  style.setProperty("--app-chat-font-size", `${sizes.chatFontSize}px`);
  style.setProperty("--app-sidebar-font-size", `${sizes.sidebarFontSize}px`);
  style.setProperty("--app-tool-font-size", `${sizes.toolFontSize}px`);
  style.setProperty("--app-input-font-size", `${sizes.inputFontSize}px`);
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

function normalizeSidebarTranslucency(value: unknown): SidebarTranslucency {
  return value === "off" ||
    value === "subtle" ||
    value === "medium" ||
    value === "strong" ||
    value === "liquid-glass"
    ? value
    : DEFAULT_SIDEBAR_TRANSLUCENCY;
}

export function applySidebarTranslucency(translucency: SidebarTranslucency): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute(SIDEBAR_TRANSLUCENCY_ATTRIBUTE, translucency);
}

function setNativeVibrancyAttribute(enabled: boolean): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute(NATIVE_VIBRANCY_ATTRIBUTE, String(enabled));
  syncBrowserChromeTheme();
}

function setWindowFocusedAttribute(focused: boolean): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute(WINDOW_FOCUSED_ATTRIBUTE, String(focused));
}

function isWindowFocused(): boolean {
  return typeof document === "undefined" ? true : document.hasFocus();
}

function syncNativeSidebarVibrancy(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  const requestId = ++nativeVibrancyRequestId;
  const bridge = window.desktopBridge;
  if (!bridge) {
    setNativeVibrancyAttribute(false);
    return;
  }

  void bridge
    .setVibrancy(enabled)
    .then((nativeVibrancyEnabled) => {
      if (requestId !== nativeVibrancyRequestId) {
        return;
      }
      setNativeVibrancyAttribute(enabled && nativeVibrancyEnabled);
    })
    .catch((error) => {
      if (requestId !== nativeVibrancyRequestId) {
        return;
      }
      setNativeVibrancyAttribute(false);
      console.error("[SIDEBAR_VIBRANCY] sync failed", error);
    });
}

if (typeof document !== "undefined") {
  const storedSettings = readBrowserClientSettings();
  applyAppFont(normalizeUiFont(storedSettings?.uiFont));
  applyCodeFont(normalizeCodeFont(storedSettings?.codeFont));
  applyUiDensity(normalizeUiDensity(storedSettings?.uiDensity));
  applySidebarTranslucency(normalizeSidebarTranslucency(storedSettings?.sidebarTranslucency));
  setWindowFocusedAttribute(isWindowFocused());
  applyFontSizes({
    codeFontSize: normalizeFontSize(storedSettings?.codeFontSize, DEFAULT_CODE_FONT_SIZE),
    chatFontSize: normalizeFontSize(storedSettings?.chatFontSize, DEFAULT_CHAT_FONT_SIZE),
    sidebarFontSize: normalizeFontSize(storedSettings?.sidebarFontSize, DEFAULT_SIDEBAR_FONT_SIZE),
    toolFontSize: normalizeFontSize(storedSettings?.toolFontSize, DEFAULT_TOOL_FONT_SIZE),
    inputFontSize: normalizeFontSize(storedSettings?.inputFontSize, DEFAULT_INPUT_FONT_SIZE),
  });
}

export function useAppFont() {
  const uiFont = useSettings((settings) => settings.uiFont);
  const codeFont = useSettings((settings) => settings.codeFont);
  const codeFontSize = useSettings((settings) => settings.codeFontSize);
  const chatFontSize = useSettings((settings) => settings.chatFontSize);
  const sidebarFontSize = useSettings((settings) => settings.sidebarFontSize);
  const toolFontSize = useSettings((settings) => settings.toolFontSize);
  const inputFontSize = useSettings((settings) => settings.inputFontSize);
  const uiDensity = useSettings((settings) => settings.uiDensity);
  const sidebarTranslucency = useSettings((settings) => settings.sidebarTranslucency);

  useEffect(() => {
    applyAppFont(uiFont);
  }, [uiFont]);

  useEffect(() => {
    applyCodeFont(codeFont);
  }, [codeFont]);

  useEffect(() => {
    applyFontSizes({ codeFontSize, chatFontSize, sidebarFontSize, toolFontSize, inputFontSize });
  }, [chatFontSize, codeFontSize, sidebarFontSize, toolFontSize, inputFontSize]);

  useEffect(() => {
    applyUiDensity(uiDensity);
  }, [uiDensity]);

  useEffect(() => {
    applySidebarTranslucency(sidebarTranslucency);
    syncNativeSidebarVibrancy(sidebarTranslucency !== "off");
  }, [sidebarTranslucency]);

  useEffect(() => {
    const syncFocusedTranslucency = () => {
      setWindowFocusedAttribute(isWindowFocused());
    };

    syncFocusedTranslucency();

    const onFocusChange = () => {
      syncFocusedTranslucency();
    };
    window.addEventListener("focus", onFocusChange);
    window.addEventListener("blur", onFocusChange);
    return () => {
      window.removeEventListener("focus", onFocusChange);
      window.removeEventListener("blur", onFocusChange);
    };
  }, []);

  return {
    uiFont,
    codeFont,
    codeFontSize,
    chatFontSize,
    sidebarFontSize,
    toolFontSize,
    inputFontSize,
    uiDensity,
    sidebarTranslucency,
  };
}
