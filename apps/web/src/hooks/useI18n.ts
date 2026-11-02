import {
  createTranslator,
  resolveUiLocale,
  type TranslateFn,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";
import { useSyncExternalStore } from "react";

import { getClientSettings, subscribeClientSettings } from "./useSettings";

/**
 * Resolved once at startup: the bridge read is a synchronous IPC call and this
 * feeds a `useSyncExternalStore` snapshot on every render. The packaged desktop
 * app pins `navigator.language` to `en-US`, so the bridge carries the real OS
 * display language there.
 */
const systemLanguage =
  (typeof window === "undefined"
    ? undefined
    : window.desktopBridge?.getPreferredSystemLanguages()[0]) ??
  (typeof navigator === "undefined" ? "en" : navigator.language);

export function getUiLocale(): UiLocale {
  return resolveUiLocale(getClientSettings().uiLanguage, systemLanguage);
}

function useUiLocale(): UiLocale {
  return useSyncExternalStore(subscribeClientSettings, getUiLocale);
}

export function useT(): TranslateFn {
  const locale = useUiLocale();
  return createTranslator(locale);
}
