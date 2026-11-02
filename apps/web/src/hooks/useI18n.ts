import {
  createTranslator,
  resolveUiLocale,
  type TranslateFn,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";
import { useSyncExternalStore } from "react";

import { getClientSettings, subscribeClientSettings } from "./useSettings";

// The packaged desktop app ships only the en-US Chromium locale, so
// navigator.language is always "en-US" there; ask the host instead, the same
// way timestampFormat.ts does.
function readSystemLocale(): string {
  return window.desktopBridge?.getSystemLocale() ?? navigator.language;
}

export function getUiLocale(): UiLocale {
  return resolveUiLocale(getClientSettings().uiLanguage, readSystemLocale());
}

function useUiLocale(): UiLocale {
  return useSyncExternalStore(subscribeClientSettings, getUiLocale);
}

export function useT(): TranslateFn {
  const locale = useUiLocale();
  return createTranslator(locale);
}
