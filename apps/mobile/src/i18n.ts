/**
 * The mobile client's i18next binding.
 *
 * Initialized at module load so the first frame already has catalogs and never
 * flashes raw keys. Registering with `initReactI18next` lets `useTranslation`
 * resolve the instance without a provider.
 */
import { initReactI18next, useTranslation } from "react-i18next";

import { createI18n } from "@t3tools/client-runtime/i18n";
import type { SupportedLanguage } from "@t3tools/client-runtime/i18n";

export const i18n = createI18n({ plugins: [initReactI18next] });

export function changeLanguage(language: SupportedLanguage): Promise<unknown> {
  return i18n.changeLanguage(language);
}

/** Translate function bound to the active language. */
export function useTranslate() {
  return useTranslation().t;
}
