import "./intl-polyfills";
import { reloadAppAsync } from "expo";
import { resolveLocaleSelection } from "@t3tools/client-runtime/locales";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GTProvider, initializeGT, useLocale } from "gt-react-native";
import {
  createContext,
  use,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AppState,
  I18nManager,
  Platform,
  TurboModuleRegistry,
  View,
  type TurboModule,
} from "react-native";

import { mobilePreferencesAtom, savedMobileLanguageAtom } from "../state/preferences";
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
  ru: () => require("./translations/ru.json"),
  sv: () => require("./translations/sv.json"),
  ar: () => require("./translations/ar.json"),
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

export function useLanguagePreference(): string {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.language ?? DEFAULT_LOCALE)
    : DEFAULT_LOCALE;
}

/** Translates the app into the saved language; "system" follows the device. Mounted once in App. */
export function I18nProvider(props: { readonly children: ReactNode }) {
  const saved = useAtomValue(savedMobileLanguageAtom);
  const savedLanguage = AsyncResult.isSuccess(saved) ? (saved.value ?? DEFAULT_LOCALE) : null;
  const [systemLocales, setSystemLocales] = useState(readSystemLocales);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android device language can change while the app is in the background.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setSystemLocales(readSystemLocales());
    });
    return () => subscription.remove();
  }, []);
  const { catalogLocale, formattingLocale } = resolveLocaleSelection(
    useLanguagePreference(),
    systemLocales,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  // GT suspends while a locale's catalog loads. Deferring the switch keeps the current language
  // on screen until then, instead of GT's full-screen spinner.
  const selection = useDeferredValue(
    useMemo(() => ({ catalogLocale, formattingLocale }), [catalogLocale, formattingLocale]),
  );
  const savedCatalogLocale =
    savedLanguage === null
      ? null
      : resolveLocaleSelection(savedLanguage, systemLocales, SUPPORTED_LOCALES, DEFAULT_LOCALE)
          .catalogLocale;
  const wantedRTL = savedCatalogLocale === null ? null : savedCatalogLocale === "ar";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- React Native applies persisted layout direction when it recreates the app.
  useEffect(() => {
    if (wantedRTL === null || I18nManager.isRTL === wantedRTL) return;
    // Allowing device RTL with forceRTL(false) would keep an Arabic device in RTL.
    I18nManager.allowRTL(wantedRTL);
    I18nManager.forceRTL(wantedRTL);
    void reloadAppAsync().catch((error: unknown) =>
      console.warn("Could not reload the app after a layout direction change.", error),
    );
  }, [wantedRTL]);
  return (
    <GTProvider locale={selection.catalogLocale} fallback={<View className="flex-1 bg-screen" />}>
      <ActiveLocale />
      <FormattingLocaleContext value={selection.formattingLocale}>
        {props.children}
      </FormattingLocaleContext>
    </GTProvider>
  );
}

function ActiveLocale() {
  const locale = useLocale();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- call-time m() outside React reads the committed locale, whose catalog GT has loaded
  useEffect(() => setActiveLocale(locale), [locale]);
  return null;
}
