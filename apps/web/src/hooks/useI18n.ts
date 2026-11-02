import {
  createTranslator,
  resolveUiLocale,
  type TranslateFn,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";
import { useSyncExternalStore } from "react";

import { getClientSettings, subscribeClientSettings } from "./clientSettingsStore";

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

// One translator per locale keeps `t` referentially stable across renders, so it
// can safely sit in effect dependency lists.
const translators = new Map<UiLocale, TranslateFn>();

function getTranslator(locale: UiLocale): TranslateFn {
  let translator = translators.get(locale);
  if (translator === undefined) {
    translator = createTranslator(locale);
    translators.set(locale, translator);
  }
  return translator;
}

export function useT(): TranslateFn {
  return getTranslator(useUiLocale());
}
