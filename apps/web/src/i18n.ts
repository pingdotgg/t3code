/**
 * The web client's i18next binding.
 *
 * The instance is configured and initialized at module load, so the first
 * render already has catalogs in memory and never flashes raw keys. Registering
 * the instance with `initReactI18next` also lets `useTranslation` find it
 * without a provider, which keeps component tests that render a screen directly
 * working unchanged.
 */
import { useEffect } from "react";
import { initReactI18next, useTranslation } from "react-i18next";

import { createI18n, resolveLanguage } from "@t3tools/client-runtime/i18n";
import type { SupportedLanguage } from "@t3tools/client-runtime/i18n";

import { useClientSettings } from "./hooks/useSettings";

export const i18n = createI18n({ plugins: [initReactI18next] });

/**
 * Switch the interface language.
 *
 * Resolves once catalogs for `language` are active. Catalogs are bundled, so
 * this never waits on a request; the returned promise keeps callers free to
 * treat it as async.
 */
export function changeLanguage(language: SupportedLanguage): Promise<unknown> {
  return i18n.changeLanguage(language);
}

/** Translate function bound to the active language. */
export function useTranslate() {
  return useTranslation().t;
}

/**
 * Applies the stored language preference to i18next and to the document.
 *
 * Rendered once above the router rather than inside a route, because
 * `__root` returns several separate trees (pair, welcome, app shell) and a
 * branch that forgets this would silently render in the source language.
 *
 * The host locale is consulted only for `system`, and only here: resolving it
 * at module load would freeze the choice before settings hydrate.
 */
export function LanguageSync() {
  const languagePreference = useClientSettings((settings) => settings.languagePreference);

  useEffect(() => {
    const language = resolveLanguage(languagePreference, navigator.languages);
    if (i18n.resolvedLanguage !== language) {
      void changeLanguage(language);
    }
    document.documentElement.lang = language;
  }, [languagePreference]);

  return null;
}
