import { getTranslationsSnapshot } from "gt-react";

import {
  getClientSettings,
  subscribeClientSettings,
  updateClientSettings,
} from "../hooks/useSettings";
import { initializeI18n } from "./initializeI18n";
import { DEFAULT_LOCALE, readSystemLocales, resolveLocale } from "./locales";

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
    // A failed load resolves without an entry, so the locale renders the English source.
    load = getTranslationsSnapshot(locale).then((loaded) => {
      loadedTranslations[locale] = loaded[locale] ?? {};
      pendingLoads.delete(locale);
    });
    pendingLoads.set(locale, load);
  }
  return load;
}

function activateLocale(locale: string): void {
  if (requestedLocale !== locale || snapshot.locale === locale) return;
  snapshot = { locale, translations: { ...loadedTranslations } };
  document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}

function applyLanguageSetting(): void {
  const locale = resolveLocale(getClientSettings().language, readSystemLocales());
  requestedLocale = locale;
  if (locale in loadedTranslations) {
    activateLocale(locale);
    return;
  }
  void loadLocale(locale).then(() => activateLocale(locale));
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
  return loadLocale(requestedLocale);
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
