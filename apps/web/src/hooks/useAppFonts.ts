import { useEffect } from "react";
import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_FONT_FAMILY,
  type ClientSettings,
} from "@t3tools/contracts/settings";

import { useSettings } from "./useSettings";

function resolveFontFamily(value: string | null | undefined, fallback: string): string {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return fallback;
  }

  if (typeof document === "undefined") {
    return trimmedValue;
  }

  const probe = document.createElement("span");
  probe.style.fontFamily = "";
  probe.style.fontFamily = trimmedValue;

  return probe.style.fontFamily ? trimmedValue : fallback;
}

export function applyAppFonts(
  settings: Pick<ClientSettings, "uiFontFamily" | "codeFontFamily">,
): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.style.setProperty(
    "--app-font-ui",
    resolveFontFamily(settings.uiFontFamily, DEFAULT_UI_FONT_FAMILY),
  );
  document.documentElement.style.setProperty(
    "--app-font-code",
    resolveFontFamily(settings.codeFontFamily, DEFAULT_CODE_FONT_FAMILY),
  );
}

export function getResolvedCodeFontFamily(): string {
  if (typeof document === "undefined") {
    return DEFAULT_CODE_FONT_FAMILY;
  }

  return resolveFontFamily(
    getComputedStyle(document.documentElement).getPropertyValue("--app-font-code"),
    DEFAULT_CODE_FONT_FAMILY,
  );
}

export function useAppFonts(): void {
  const uiFontFamily = useSettings((settings) => settings.uiFontFamily);
  const codeFontFamily = useSettings((settings) => settings.codeFontFamily);

  useEffect(() => {
    applyAppFonts({ uiFontFamily, codeFontFamily });
  }, [codeFontFamily, uiFontFamily]);
}
