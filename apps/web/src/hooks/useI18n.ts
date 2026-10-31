import {
  createTranslator,
  resolveUiLocale,
  type TranslateFn,
  type UiLocale,
} from "@t3tools/client-runtime/i18n";
import { useSyncExternalStore } from "react";

import { getClientSettings, subscribeClientSettings } from "./useSettings";

export function getUiLocale(): UiLocale {
  return resolveUiLocale(getClientSettings().uiLanguage, navigator.language);
}

function useUiLocale(): UiLocale {
  return useSyncExternalStore(subscribeClientSettings, getUiLocale);
}

export function useT(): TranslateFn {
  const locale = useUiLocale();
  return createTranslator(locale);
}
