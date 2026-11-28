import { resolveLocaleSelection } from "@t3tools/client-runtime/locales";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GTProvider, initializeGT, useLocale } from "gt-react-native";
import { createContext, use, useDeferredValue, useEffect, useMemo, type ReactNode } from "react";
import { Platform, TurboModuleRegistry, View, type TurboModule } from "react-native";

import { setAndroidAgentNotificationsLocale } from "../features/agent-awareness/androidNotifications";
import { mobilePreferencesAtom } from "../state/preferences";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";
import { setActiveLocale } from "./messages";

const FormattingLocaleContext = createContext(DEFAULT_LOCALE);

export function useFormattingLocale(): string {
  return use(FormattingLocaleContext);
}

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
  pl: () => require("./translations/pl.json"),
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

// Read the device languages from gt-react-native's own native module: GT's getLocale() prefers
// the last locale passed to GTProvider, which it persists, so it can't express "system".
function readSystemLocales(): ReadonlyArray<string> {
  try {
    const locales =
      TurboModuleRegistry.get<{ getNativeLocales(): string[] } & TurboModule>(
        "GtReactNative",
      )?.getNativeLocales() ?? [];
    // On iOS the first entry is NSLocale.currentLocale, whose language is the app's bundle
    // localization (English only), not the user's; preferredLanguages follow it.
    return Platform.OS === "ios" ? locales.slice(1) : locales;
  } catch {
    return [];
  }
}

function useResolvedLanguagePreference() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const resolved = AsyncResult.isSuccess(preferences);
  return {
    resolved,
    language: resolved ? (preferences.value.language ?? DEFAULT_LOCALE) : DEFAULT_LOCALE,
  };
}

export function useLanguagePreference(): string {
  return useResolvedLanguagePreference().language;
}

/** Translates the app into the saved language; "system" follows the device. Mounted once in App. */
export function I18nProvider(props: { readonly children: ReactNode }) {
  const { resolved, language } = useResolvedLanguagePreference();
  const { catalogLocale, formattingLocale } = resolveLocaleSelection(
    language,
    readSystemLocales(),
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  // GT suspends while a locale's catalog loads. Deferring the switch keeps the current language
  // on screen until then, instead of GT's full-screen spinner.
  const selection = useDeferredValue(
    useMemo(() => ({ catalogLocale, formattingLocale }), [catalogLocale, formattingLocale]),
  );
  return (
    <GTProvider locale={selection.catalogLocale} fallback={<View className="flex-1 bg-screen" />}>
      <ActiveLocale resolvedLocale={resolved ? catalogLocale : null} />
      <FormattingLocaleContext value={selection.formattingLocale}>
        {props.children}
      </FormattingLocaleContext>
    </GTProvider>
  );
}

function ActiveLocale(props: { readonly resolvedLocale: string | null }) {
  const locale = useLocale();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- call-time m() outside React and Android native notifications read the committed locale
  useEffect(() => {
    setActiveLocale(locale);
    if (props.resolvedLocale !== null && locale === props.resolvedLocale) {
      setAndroidAgentNotificationsLocale(locale);
    }
  }, [locale, props.resolvedLocale]);
  return null;
}
