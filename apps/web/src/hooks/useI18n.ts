import {
  createTranslator,
  resolveUiLocale,
  type TranslateFn,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";
import { useSyncExternalStore } from "react";

import { getClientSettings, subscribeClientSettings } from "./clientSettingsStore";

/**
 * Resolved once at startup: the bridge read is a synchronous IPC call and this
 * feeds a `useSyncExternalStore` snapshot on every render. The packaged desktop
 * app pins `navigator.language` to `en-US`, so the bridge carries the real OS
 * display language there.
 */
const systemLanguage =
  (typeof window === "undefined"
    ? undefined
    : window.desktopBridge?.getPreferredSystemLanguages?.()[0]) ??
  (typeof navigator === "undefined" ? undefined : navigator.language) ??
  "en";

export function getUiLocale(): UiLocale {
  return resolveUiLocale(getClientSettings().uiLanguage, systemLanguage);
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
