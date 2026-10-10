/**
 * The mobile client's i18next binding.
 *
 * Initialized at module load so the first frame already has catalogs and never
 * flashes raw keys. Registering with `initReactI18next` lets `useTranslation`
 * resolve the instance without a provider.
 */
import { initReactI18next, useTranslation } from "react-i18next";
import { useEffect } from "react";
import { AppState } from "react-native";
import { getLocales } from "expo-localization";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "./state/preferences";

import { createI18n, resolveLanguage } from "@t3tools/client-runtime/i18n";
import type { SupportedLanguage } from "@t3tools/client-runtime/i18n";

export const i18n = createI18n({ plugins: [initReactI18next] });

export function changeLanguage(language: SupportedLanguage): Promise<unknown> {
  return i18n.changeLanguage(language);
}

/** Translate function bound to the active language. */
export function useTranslate() {
  return useTranslation().t;
}

/** Resolve only loaded preferences, and re-read device UI locales on foregrounding. */
export function LanguageSync() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const languagePreference = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.languagePreference ?? "system")
    : null;

  useEffect(() => {
    if (languagePreference === null) return;

    const syncLanguage = () => {
      const language = resolveLanguage(
        languagePreference,
        getLocales().map((locale) => locale.languageTag),
      );
      if (i18n.resolvedLanguage !== language) void changeLanguage(language);
    };
    syncLanguage();
    if (languagePreference !== "system") return;

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") syncLanguage();
    });
    return () => subscription.remove();
  }, [languagePreference]);

  return null;
}
