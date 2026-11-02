import {
  translateMessage,
  type MessageKey,
  type TranslateParams,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";

import { getUiLocale } from "../../hooks/useI18n";

/** Translate outside React (thrown errors, toasts fired from plain functions). */
export function translateNow(key: MessageKey, params?: TranslateParams): string {
  let locale: UiLocale = "en";
  try {
    locale = getUiLocale();
  } catch {
    // No window (non-browser test environments): keep English.
  }
  return translateMessage(locale, key, params);
}
