import "./intl-polyfills";
import { resolveLocale } from "@t3tools/client-runtime/locales";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GTProvider, initializeGT, useLocale } from "gt-react-native";
import { useDeferredValue, useEffect, type ReactNode } from "react";
import { View } from "react-native";

import { mobilePreferencesAtom } from "../state/preferences";
import { DEFAULT_LOCALE, readSystemLocales, SUPPORTED_LOCALES } from "./locales";
import { setActiveLocale } from "./messages";

// Committed catalogs, so forks and offline installs never reach GT's CDN. English is the source.
// Required on demand: Metro runs every statically imported module at startup, and only one
// locale's catalog is ever used.
const CATALOGS: Readonly<Record<string, () => unknown>> = {
  es: () => require("./translations/es.json"),
  zh: () => require("./translations/zh.json"),
  "pt-BR": () => require("./translations/pt-BR.json"),
  fr: () => require("./translations/fr.json"),
  de: () => require("./translations/de.json"),
  ja: () => require("./translations/ja.json"),
  ko: () => require("./translations/ko.json"),
  ru: () => require("./translations/ru.json"),
  sv: () => require("./translations/sv.json"),
};

initializeGT({
  defaultLocale: DEFAULT_LOCALE,
  locales: [...SUPPORTED_LOCALES],
  loadTranslations: async (locale: string) => CATALOGS[locale]?.() ?? {},
  // Loaded catalogs never go stale; GT's default 60 s expiry would only reload the same file.
  cacheExpiryTime: null,
});

export function useLanguagePreference(): string {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.language ?? DEFAULT_LOCALE)
    : DEFAULT_LOCALE;
}

/** Translates the app into the saved language; "system" follows the device. Mounted once in App. */
export function I18nProvider(props: { readonly children: ReactNode }) {
  // GT suspends while a locale's catalog loads. Deferring the switch keeps the current language
  // on screen until then, instead of GT's full-screen spinner.
  const locale = useDeferredValue(
    resolveLocale(useLanguagePreference(), readSystemLocales(), SUPPORTED_LOCALES, DEFAULT_LOCALE),
  );
  return (
    <GTProvider locale={locale} fallback={<View className="flex-1 bg-screen" />}>
      <ActiveLocale />
      {props.children}
    </GTProvider>
  );
}

function ActiveLocale() {
  const locale = useLocale();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- call-time m() outside React reads the committed locale, whose catalog GT has loaded
  useEffect(() => setActiveLocale(locale), [locale]);
  return null;
}
