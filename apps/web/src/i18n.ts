import { type UiLocale } from "@t3tools/contracts/settings";

import { i18n, resolveUiLanguage, type UiLanguage } from "./i18nCore";
import { subscribeActiveUiLocale } from "./hooks/useUiLocale";

export { i18n, resolveUiLanguage, type UiLanguage };

function applyUiLocale(uiLocale: UiLocale): void {
  void i18n.changeLanguage(
    resolveUiLanguage(uiLocale, [...(navigator.languages ?? []), navigator.language]),
  );
}

/** Applies the synced uiLocale now and on every server settings push. */
export function startUiLocaleSync(): () => void {
  return subscribeActiveUiLocale(applyUiLocale);
}

/** Cycles system → en → zh-Hans → system. */
export function nextUiLocale(uiLocale: UiLocale): UiLocale {
  return uiLocale === "system" ? "en" : uiLocale === "en" ? "zh-Hans" : "system";
}
