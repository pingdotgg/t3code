import { resolveLocale } from "@t3tools/client-runtime/locales";
import { getTranslationsSnapshot } from "gt-react";

import {
  getClientSettings,
  subscribeClientSettings,
  updateClientSettings,
} from "../hooks/useSettings";
import { initializeI18n } from "./initializeI18n";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";

type LocaleTranslations = Awaited<ReturnType<typeof getTranslationsSnapshot>>;

export interface I18nSnapshot {
  readonly locale: string;
  readonly translations: LocaleTranslations;
}

const loadedTranslations: LocaleTranslations = { [DEFAULT_LOCALE]: {} };
const pendingLoads = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let snapshot: I18nSnapshot = { locale: DEFAULT_LOCALE, translations: { ...loadedTranslations } };
let requestedLocale = DEFAULT_LOCALE;

function loadLocale(locale: string): Promise<void> {
  if (locale in loadedTranslations) return Promise.resolve();
  let load = pendingLoads.get(locale);
  if (!load) {
    // GT resolves a failed load to an empty catalog. Leave it uncached: English renders now
    // and the next request retries.
    load = getTranslationsSnapshot(locale).then((loaded) => {
      pendingLoads.delete(locale);
      const translations = loaded[locale];
      if (translations && Object.keys(translations).length > 0) {
        loadedTranslations[locale] = translations;
      }
    });
    pendingLoads.set(locale, load);
  }
  return load;
}

function activateLocale(locale: string): void {
  if (requestedLocale !== locale) return;
  if (snapshot.locale === locale && snapshot.translations[locale] === loadedTranslations[locale]) {
    return;
  }
  snapshot = { locale, translations: { ...loadedTranslations } };
  document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}

function applyLanguageSetting(): void {
  // Not desktopBridge.getSystemLocale(): that is the regional/time locale, not the UI language.
  requestedLocale = resolveLocale(
    getClientSettings().language,
    navigator.languages,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  void whenLocaleReady();
}

/** GT's own locale setters write the saved setting, which stays the only source of truth. */
export function persistGTLocale(locale: string): void {
  void updateClientSettings({ language: locale });
}

export function startI18n(): void {
  initializeI18n(persistGTLocale);
  subscribeClientSettings(applyLanguageSetting);
  applyLanguageSetting();
}

/** Resolves once the requested locale's translations are ready; immediate for English. */
export function whenLocaleReady(): Promise<void> {
  const locale = requestedLocale;
  return loadLocale(locale).then(() => activateLocale(locale));
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getI18nSnapshot(): I18nSnapshot {
  return snapshot;
}
